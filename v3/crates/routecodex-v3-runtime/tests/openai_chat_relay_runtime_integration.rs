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
    assert_eq!(
        captured["tools"],
        json!([{
            "type": "function",
            "name": "lookup",
            "function": {"name": "lookup", "parameters": {"type": "object"}}
        }]),
        "openai_chat provider wire normalizes tools to dual-field shape (top-level name + nested function)"
    );
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
                body_read_failure: None,
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
                    body_read_failure: None,
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
    assert!(
        client_response["error"].get("stage").is_none()
            && client_response["error"].get("class").is_none()
            && client_response["error"].get("error_node").is_none()
            && client_response["error"].get("decision").is_none()
            && client_response["error"].get("external_error").is_none(),
        "Error06 body must not carry control-plane fields: {client_response}"
    );
    assert!(
        client_response["error"].get("type").is_none(),
        "provider raw error body must not bypass ErrorErr06 projection: {client_response}"
    );
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
}

#[tokio::test]
async fn malformed_anthropic_response_enters_typed_error_chain_not_panic() {
        // 红测：malformed Anthropic 响应（content 缺 type / 非法 type）经
        // RespInbound02 归一化失败时必须走 typed Error01-06 链（ErrorErr06
        // 投影），禁止 .expect() stack panic 绕过错误链。
        struct MalformedAnthropicTransport;
        #[async_trait]
        impl ResponsesTransport for MalformedAnthropicTransport {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                Ok(V3ProviderResp14Raw::from_json(
                    request.request_id().to_string(),
                    request.provider_id().to_string(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"application/json".to_vec(),
                    }],
                    serde_json::to_vec(&json!({
                        "id": "msg_malformed",
                        "type": "message",
                        "role": "assistant",
                        "model": "MiniMax-M3",
                        "content": [{"type": "bogus", "text": "x"}],
                        "stop_reason": "end_turn",
                        "usage": {"input_tokens": 1, "output_tokens": 1}
                    }))
                    .unwrap(),
                ))
            }
        }

        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
endpoints = ["openai_chat"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools"]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();

        let output = execute_v3_openai_chat_relay_runtime(
            &manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: "s".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    "openai-chat-malformed-anthropic",
                )
                .expect("scope"),
                request_id: "openai-chat-malformed-anthropic-1".into(),
                payload: json!({
                    "model": "MiniMax-M3",
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": false
                }),
            },
            &MalformedAnthropicTransport,
        )
        .await
        .expect("malformed provider response must project a typed terminal, not panic");
        assert_eq!(output.status, 502);
        assert_eq!(
            output.error_chain.as_ref().unwrap().len(),
            6,
            "malformed Anthropic response must travel the typed Error01-06 chain"
        );
        assert_eq!(
            output.node_trace.last(),
            Some(&"V3Error06ClientProjected"),
            "terminal node must be Error06 projection, not a panic"
        );
        let client_response = match output.client_body {
            V3OpenAiChatRelayClientBody::Json(value) => value,
            V3OpenAiChatRelayClientBody::Sse(_) => panic!("expected JSON error body"),
        };
        assert!(client_response["error"].get("error_node").is_none());
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
                    body_read_failure: None,
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
async fn sse_done_before_terminal_fails_and_terminal_without_done_succeeds() {
    use futures_util::StreamExt;
    let failing_cases = [
        (vec![b"data: [DONE]\n\n".to_vec()], "before terminal"),
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
    for (chunks, expected) in failing_cases {
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

    // 合法 terminal finish_reason 后 EOF（无 [DONE]）：provider 合法关闭流，
    // 网关必须补齐客户端协议终止帧。
    let transport = StaticSseTransport {
        chunks: Mutex::new(Some(vec![
            br#"data: {"id":"ok","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

"#
            .to_vec(),
        ])),
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
            request_id: "req-sse-terminal-no-done".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"terminal stream"}],
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
    assert!(
        items.iter().all(|item| item.is_ok()),
        "terminal finish_reason without upstream [DONE] must project success: {items:?}"
    );
    assert!(
        items
            .iter()
            .any(|item| item.as_ref().is_ok_and(|chunk| chunk == b"data: [DONE]\n\n")),
        "gateway must terminate the client SSE stream with [DONE]: {items:?}"
    );
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

    // post-commit SSE 流失败是强故障信号：直接写 provider 级冷却，
    // fresh 请求被冷却阻断（不再每请求都试），恢复唯一路径是后台 probe。
    let succeeding = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let blocked = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-blocked-after-post-commit".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"blocked"}],
                "stream":false
            }),
        },
        &succeeding,
        provider_health.runtime_health(),
    )
    .await;
    assert!(
        blocked.is_err(),
        "fresh request must be blocked while provider cooldown is active"
    );

    // probe 通过 → provider 恢复 → fresh 成功。
    provider_health
        .runtime_health()
        .run_due_provider_cooldown_probes(u64::MAX, |_, _, _| async { Ok(()) })
        .await
        .expect("probe cycle must revive cooled provider");
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
    .expect("second provider action after probe pass");
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
    // post-commit 失败已冷却 provider；probe 通过后 terminal/fresh 请求可达，
    // 且不占用 Error05 recovery lane（terminal 失败只写冷却，不驻留恢复门）。
    let probed = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let probed_for_probe = std::sync::Arc::clone(&probed);
    provider_health
        .runtime_health()
        .run_due_provider_cooldown_probes(u64::MAX, move |provider_id, _, _| {
            let probed_for_probe = std::sync::Arc::clone(&probed_for_probe);
            async move {
                probed_for_probe.lock().unwrap().push(provider_id);
                Ok(())
            }
        })
        .await
        .expect("probe cycle must revive cooled provider");
    assert!(
        !probed.lock().unwrap().is_empty(),
        "probe cycle must probe the cooled provider, probed: {:?}",
        probed.lock().unwrap()
    );
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
        error
            .to_string()
            .contains("direct provider model controlled.unknown-model is not configured"),
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

struct AnthropicWireCaptureTransport {
    captured_url: Mutex<Option<String>>,
}

struct AnthropicSseTransport {
    captured_url: Mutex<Option<String>>,
    chunks: Mutex<Option<Vec<Vec<u8>>>>,
}

#[async_trait]
impl ResponsesTransport for AnthropicWireCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured_url.lock().unwrap() = Some(request.url().to_string());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id": "msg_mm_1",
                "type": "message",
                "role": "assistant",
                "model": "MiniMax-M3",
                "content": [
                    {"type": "text", "text": "the image is blue"}
                ],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 11, "output_tokens": 5}
            }))
            .unwrap(),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for AnthropicSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured_url.lock().unwrap() = Some(request.url().to_string());
        let chunks = self.chunks.lock().unwrap().take().unwrap();
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(futures_util::stream::iter(chunks.into_iter().map(Ok))),
        ))
    }
}

#[tokio::test]
async fn openai_chat_anthropic_sse_emits_first_delta_before_message_stop() {
    use futures_util::StreamExt;
    let transport = AnthropicSseTransport {
        captured_url: Mutex::new(None),
        chunks: Mutex::new(Some(vec![
            br#"event: message_start
data: {"type":"message_start","message":{"id":"msg-chat-sse","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"usage":{"input_tokens":11}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"early"}}

"#.to_vec(),
        ])),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest_with_anthropic_multimodal(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "cross_protocol".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "chat-anthropic-sse",
            )
            .expect("scope"),
            request_id: "chat-anthropic-sse-1".into(),
            payload: json!({
                "model": "deepseek-v4-flash",
                "messages": [{"role":"user","content":[
                    {"type":"text","text":"stream"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}
                ]}],
                "stream": true
            }),
        },
        &transport,
    )
    .await
    .expect("Anthropic SSE relay must return a lazy client stream");
    let url = transport
        .captured_url
        .lock()
        .unwrap()
        .clone()
        .expect("provider request must be captured");
    assert!(url.contains("/v1/messages"));
    let mut stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let first = tokio::time::timeout(Duration::from_millis(100), stream.next())
        .await
        .expect("first frame must not wait for message_stop")
        .unwrap()
        .unwrap();
    let first = String::from_utf8(first).unwrap();
    assert!(first.contains("chat.completion.chunk"));
    assert!(first.contains("assistant"));
}

#[tokio::test]
async fn openai_chat_anthropic_sse_requires_message_stop_and_done() {
    use futures_util::StreamExt;
    let transport = AnthropicSseTransport {
        captured_url: Mutex::new(None),
        chunks: Mutex::new(Some(vec![br#"event: message_start
data: {"type":"message_start","message":{"id":"msg-incomplete","type":"message","role":"assistant","model":"MiniMax-M3","content":[]}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}

"#.to_vec()])),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest_with_anthropic_multimodal(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "cross_protocol".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "chat-anthropic-sse-incomplete",
            )
            .expect("scope"),
            request_id: "chat-anthropic-sse-incomplete-1".into(),
            payload: json!({
                "model": "deepseek-v4-flash",
                "messages": [{"role":"user","content":[
                    {"type":"text","text":"stream"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}
                ]}],
                "stream": true
            }),
        },
        &transport,
    )
    .await
    .expect("the lazy stream owns terminal validation");
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    assert!(events
        .first()
        .expect("role frame")
        .as_ref()
        .unwrap()
        .starts_with(b"data: "));
    assert!(events
        .last()
        .expect("terminal error")
        .as_ref()
        .expect_err("incomplete Anthropic stream must fail")
        .contains("message_stop"));
}

#[tokio::test]
async fn openai_chat_anthropic_sse_complete_stream_emits_client_done_without_provider_done() {
    // 正向回归：Anthropic Messages wire 无 [DONE] 定义（标准流以 message_stop
    // 结束）。完整流（message_stop→EOF）必须成功，网关在客户端侧补发 [DONE]
    // sentinel，且缺失 [DONE] 不记录 provider-health 失败。
    use futures_util::StreamExt;
    let manifest = manifest_with_anthropic_multimodal();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let transport = AnthropicSseTransport {
        captured_url: Mutex::new(None),
        chunks: Mutex::new(Some(vec![br#"event: message_start
data: {"type":"message_start","message":{"id":"msg-complete","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"usage":{"input_tokens":5}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"complete"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}

event: message_stop
data: {"type":"message_stop"}

"#.to_vec()])),
    };
    let output = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "cross_protocol".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "chat-anthropic-sse-complete",
            )
            .expect("scope"),
            request_id: "chat-anthropic-sse-complete-1".into(),
            payload: json!({
                "model": "deepseek-v4-flash",
                "messages": [{"role":"user","content":[
                    {"type":"text","text":"stream"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}
                ]}],
                "stream": true
            }),
        },
        &transport,
        provider_health.runtime_health(),
    )
    .await
    .expect("complete Anthropic stream must project lazily and succeed");
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    assert!(
        events.iter().all(Result::is_ok),
        "complete Anthropic stream must not error; events={events:?}"
    );
    let frames: Vec<String> = events
        .into_iter()
        .map(|item| String::from_utf8_lossy(&item.expect("frame")).to_string())
        .collect();
    let joined = frames.concat();
    assert!(
        joined.contains("data: [DONE]\n\n"),
        "gateway must emit client-side [DONE] sentinel at message_stop closeout: {joined:?}"
    );
    assert!(
        joined.contains("\"content\":\"complete\"")
            && joined.contains("\"finish_reason\":\"stop\""),
        "client frames must carry text and terminal finish_reason: {joined:?}"
    );
    let availability = provider_health.store().availability(
        "mm",
        Some("key1"),
        Some("MiniMax-M3"),
        u64::MAX,
    );
    assert!(
        availability.available && availability.blocked_scopes.is_empty(),
        "missing provider [DONE] must not record provider-health failure: {availability:?}"
    );
}

#[tokio::test]
async fn openai_chat_entry_serves_anthropic_wire_multimodal_provider_via_standard_outbound() {
    let manifest = manifest_with_anthropic_multimodal();
    let transport = AnthropicWireCaptureTransport {
        captured_url: Mutex::new(None),
    };
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "what color is this image"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
            ]
        }],
        "stream": false
    });
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "cross_protocol".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "cross-protocol-image",
            )
            .expect("scope"),
            request_id: "cross-protocol-image-1".into(),
            payload,
        },
        &transport,
    )
    .await
    .expect("relay must complete");
    let url = transport
        .captured_url
        .lock()
        .unwrap()
        .clone()
        .expect("provider request must be captured");
    assert!(
        url.contains("/v1/messages"),
        "anthropic wire provider must use the standard anthropic messages outbound, got {url}"
    );
    assert_eq!(output.status, 200);
    let V3OpenAiChatRelayClientBody::Json(client) = output.client_body else {
        panic!("expected JSON client body for stream=false");
    };
    assert_eq!(
        client["choices"][0]["message"]["content"],
        "the image is blue"
    );
    assert_eq!(client["choices"][0]["finish_reason"], "stop");
    assert_eq!(client["usage"]["prompt_tokens"], 11);
    assert_eq!(client["usage"]["completion_tokens"], 5);
}

fn manifest_with_anthropic_multimodal() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.cross_protocol]
bind = "127.0.0.1"
port = 1
routing_group = "cross_protocol"
endpoints = ["openai_chat", "responses"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "multimodal", "vision"]
[providers.text]
type = "openai_chat"
base_url = "http://text.invalid/v1"
default_model = "deepseek-v4-flash"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TXT_KEY" }] }
[providers.text.models.deepseek-v4-flash]
wire_name = "deepseek-v4-flash"
capabilities = ["text", "tools"]
[route_groups.cross_protocol.pools.multimodal]
selection = { strategy = "priority" }
match = { precedence = 0, required_capabilities = ["multimodal"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.cross_protocol.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "text", model = "deepseek-v4-flash", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn model_pool_wins_over_default_even_with_custom_tool_declaration() {
    let manifest = manifest_with_model_pool_and_custom_tools();
    let transport = AnthropicWireCaptureTransport {
        captured_url: Mutex::new(None),
    };
    let payload = json!({
        "model": "MiniMax-M3",
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "description": "edit files",
            "format": {"type": "grammar", "syntax": "lark", "definition": "start: patch"}
        }],
        "stream": false
    });
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "model_pool".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "model-pool-custom-tool",
            )
            .expect("scope"),
            request_id: "model-pool-custom-tool-1".into(),
            payload,
        },
        &transport,
    )
    .await
    .expect("relay must complete");
    let url = transport
        .captured_url
        .lock()
        .unwrap()
        .clone()
        .expect("provider request must be captured");
    assert!(
        url.contains("/v1/messages"),
        "client model pool must win over default pool, got {url}"
    );
    assert_eq!(output.status, 200);
    let V3OpenAiChatRelayClientBody::Json(client) = output.client_body else {
        panic!("expected JSON client body for stream=false");
    };
    assert_eq!(
        client["choices"][0]["message"]["content"],
        "the image is blue"
    );
}

fn manifest_with_model_pool_and_custom_tools() -> routecodex_v3_config::V3Config05ManifestPublished
{
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.model_pool]
bind = "127.0.0.1"
port = 1
routing_group = "model_pool"
endpoints = ["openai_chat", "responses"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "multimodal", "vision"]
[providers.text]
type = "openai_chat"
base_url = "http://text.invalid/v1"
default_model = "deepseek-v4-flash"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TXT_KEY" }] }
[providers.text.models.deepseek-v4-flash]
wire_name = "deepseek-v4-flash"
capabilities = ["text", "tools"]
[route_groups.model_pool.pools.minimax_m3]
selection = { strategy = "priority" }
match = { precedence = 15, models = ["MiniMax-M3"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.model_pool.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "text", model = "deepseek-v4-flash", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_with_anthropic_mode_b_websearch() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.cross_protocol]
bind = "127.0.0.1"
port = 1
routing_group = "cross_protocol"
endpoints = ["openai_chat", "responses"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "multimodal", "vision", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.cross_protocol.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.cross_protocol.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

struct AnthropicWebSearchWireTransport {
    captured_request: Mutex<Option<Value>>,
}

#[async_trait]
impl ResponsesTransport for AnthropicWebSearchWireTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured_request.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id": "msg_mm_ws_1",
                "type": "message",
                "role": "assistant",
                "model": "MiniMax-M3",
                "content": [
                    {"type": "tool_use", "id": "call_ws_1", "name": "web_search",
                     "input": {"query": "routecodex"}}
                ],
                "stop_reason": "tool_use",
                "usage": {"input_tokens": 11, "output_tokens": 5}
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn openai_chat_entry_mode_b_web_search_intercepted_must_fail_fast_not_silently_strip() {
    // 红测：chat 入口 + Mode B web_search 拦截后无结果投影路径，
    // 必须显式 WebSearchInterceptedUnprojected，禁止静默剥离成普通文本。
    let manifest = manifest_with_anthropic_mode_b_websearch();
    let payload = json!({
        "model": "MiniMax-M3",
        "messages": [{"role": "user", "content": "search routecodex"}],
        "tools": [{"type": "function", "function": {"name": "websearch", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
        "stream": false
    });
    let transport = AnthropicWebSearchWireTransport {
        captured_request: Mutex::new(None),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "cross_protocol".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "openai-chat-mode-b-ws",
            )
            .expect("scope"),
            request_id: "openai-chat-mode-b-ws-1".into(),
            payload,
        },
        &transport,
    )
    .await;
    // 请求 wire 必须保留 web_search 工具（Mode B outbound 投影）。
    let wire = transport
        .captured_request
        .lock()
        .unwrap()
        .clone()
        .expect("provider request wire must be captured");
    let tool_names: Vec<&str> = wire["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .or_else(|| tool.pointer("/function/name").and_then(Value::as_str))
        })
        .collect();
    assert!(
        tool_names.iter().any(|name| *name == "web_search"),
        "provider wire must keep web_search server tool, got: {tool_names:?}"
    );
    let err =
        output.expect_err("Mode B web_search interception must fail fast, not silently strip");
    match err {
        routecodex_v3_runtime::V3OpenAiChatRelayRuntimeError::WebSearchInterceptedUnprojected => {}
        other => panic!("expected WebSearchInterceptedUnprojected, got: {other:?}"),
    }
}

#[test]
fn routing_image_attachment_is_current_turn_only_not_history() {
    let chat_history_image_then_text = json!({
        "model": "deepseek-v4-flash",
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": "look"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
            ]},
            {"role": "assistant", "content": "I see the image"},
            {"role": "user", "content": "now explain it"}
        ]
    });
    let chat_current_turn_image = json!({
        "model": "deepseek-v4-flash",
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": [
                {"type": "text", "text": "what is this"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}
            ]}
        ]
    });
    let responses_history_image_then_text = json!({
        "model": "deepseek-v4-flash",
        "input": [
            {"role": "user", "content": [
                {"type": "input_text", "text": "look"},
                {"type": "input_image", "image_url": {"url": "data:image/png;base64,AAAA"}}
            ]},
            {"role": "assistant", "output_text": "I see the image"},
            {"role": "user", "content": [{"type": "input_text", "text": "now explain it"}]}
        ]
    });
    let cases = [
        (
            "chat history image + current text",
            &chat_history_image_then_text,
            "openai_chat",
            false,
        ),
        (
            "chat current turn image",
            &chat_current_turn_image,
            "openai_chat",
            true,
        ),
        (
            "responses history image + current text",
            &responses_history_image_then_text,
            "responses",
            false,
        ),
    ];
    for (label, body, entry, expect_multimodal) in cases {
        let facts =
            routecodex_v3_runtime::build_v3_router_request_facts_for_entry(body, entry, None);
        assert_eq!(
            facts.capabilities.contains("multimodal"),
            expect_multimodal,
            "{label}: multimodal capability mismatch; caps={:?}",
            facts.capabilities
        );
        assert_eq!(
            facts.route_classification.route_name,
            if expect_multimodal {
                "multimodal"
            } else {
                "thinking"
            },
            "{label}: route mismatch"
        );
    }
}

#[tokio::test]
async fn openai_chat_sse_mode_b_web_search_rejects_stream_before_silent_passthrough() {
    // 红测：OpenAiChat wire SSE + Mode B 激活时，流式帧无法逐 chunk 拦截，
    // 必须 fail-fast（WebSearchInterceptedUnprojected），禁止静默透传。
    use futures_util::StreamExt;
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.ws]
bind = "127.0.0.1"
port = 1
routing_group = "ws"
endpoints = ["openai_chat"]
[providers.wschat]
type = "openai_chat"
base_url = "http://wschat.invalid/v1"
default_model = "ws-wire-model"
auth = { type = "api_key", entries = [{ alias = "key1", env = "WS_KEY" }] }
[providers.wschat.models.ws-wire-model]
wire_name = "ws-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.ws.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "wschat", model = "ws-wire-model", key = "key1", priority = 1 }]
[route_groups.ws.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "wschat", model = "ws-wire-model", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();

    struct SseWsTransport;
    #[async_trait]
    impl ResponsesTransport for SseWsTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            let stream = futures_util::stream::iter([
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_ws\",\"type\":\"function\",\"function\":{\"name\":\"websearch\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n".to_vec()),
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"query\\\":\\\"x\\\"}\"}}]},\"finish_reason\":null}]}\n\n".to_vec()),
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n".to_vec()),
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

    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "ws".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "openai-chat-sse-mode-b-ws",
            )
            .expect("scope"),
            request_id: "openai-chat-sse-mode-b-ws-1".into(),
            payload: json!({
                "model": "ws-wire-model",
                "messages": [{"role": "user", "content": "search the web for x"}],
                "tools": [{"type": "function", "function": {"name": "websearch",
                 "description": "Search the web", "parameters": {"type":"object","properties":{}}}}],
                "stream": true
            }),
        },
        &SseWsTransport,
    )
    .await
    .expect("SSE stream is projected lazily; fail-fast happens per-frame in the stream");
    assert_eq!(output.status, 200);
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    let errors: Vec<_> = events
        .iter()
        .filter_map(|item| item.as_ref().err())
        .collect();
    assert!(
        !errors.is_empty(),
        "Mode B SSE web_search must fail fast inside the stream, not silently pass through; events={events:?}"
    );
    assert!(
        errors
            .iter()
            .any(|error| error.contains("ROUTECODEX_GOVERNANCE_REJECTED")),
        "stream failure must be the governance rejection signal, got: {errors:?}"
    );
}

#[tokio::test]
async fn openai_chat_sse_mode_b_plain_text_stream_passes_through_without_websearch_call() {
    // 防误伤：Mode B 激活 + OpenAiChat wire SSE 纯文本流（无 websearch tool call）
    // 必须正常透传（逐帧判定只在出现本地 websearch tool call 时 fail-fast）。
    use futures_util::StreamExt;
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.ws]
bind = "127.0.0.1"
port = 1
routing_group = "ws"
endpoints = ["openai_chat"]
[providers.wschat]
type = "openai_chat"
base_url = "http://wschat.invalid/v1"
default_model = "ws-wire-model"
auth = { type = "api_key", entries = [{ alias = "key1", env = "WS_KEY" }] }
[providers.wschat.models.ws-wire-model]
wire_name = "ws-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.ws.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "wschat", model = "ws-wire-model", key = "key1", priority = 1 }]
[route_groups.ws.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "wschat", model = "ws-wire-model", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();

    struct SseWsTextTransport;
    #[async_trait]
    impl ResponsesTransport for SseWsTextTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            let stream = futures_util::stream::iter([
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws-text\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"plain text\"},\"finish_reason\":null}]}\n\n".to_vec()),
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws-text\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_vec()),
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

    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "ws".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "openai-chat-sse-mode-b-ws-text",
            )
            .expect("scope"),
            request_id: "openai-chat-sse-mode-b-ws-text-1".into(),
            payload: json!({
                "model": "ws-wire-model",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": true
            }),
        },
        &SseWsTextTransport,
    )
    .await
    .expect("plain text SSE stream must succeed under Mode B");
    assert_eq!(output.status, 200);
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    let errors: Vec<_> = events
        .iter()
        .filter_map(|item| item.as_ref().err())
        .collect();
    assert!(
        errors.is_empty(),
        "Mode B plain-text SSE stream must not be rejected; errors={errors:?} events={events:?}"
    );
    let frames: Vec<_> = events
        .into_iter()
        .map(|item| item.expect("frame"))
        .collect();
    let text = String::from_utf8_lossy(&frames.concat()).to_string();
    assert!(
        text.contains("plain text") && text.contains("[DONE]"),
        "client frames must carry plain text and [DONE]: {text:?}"
    );
}

#[tokio::test]
async fn openai_chat_mode_b_mismatch_without_request_activation_fails_fast_on_websearch_call() {
    // 候选 Mode B（pool 直连）但请求侧未激活 websearch surface（model 缺失
    // 导致 Req04 不激活）。provider 返回 hosted `web_search` server tool →
    // 按 2026-08-08 语义透传为 chat tool_calls（客户端执行搜索，MEMORY 4241）；
    // 仅本地 `websearch` function tool call 才 fail-fast。
    let manifest = manifest_with_anthropic_mode_b_websearch();
    let transport = AnthropicWebSearchWireTransport {
        captured_request: Mutex::new(None),
    };
    let payload = json!({
        "messages": [{"role": "user", "content": "search routecodex"}],
        "tools": [{"type": "function", "function": {"name": "websearch", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
        "stream": false
    });
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "cross_protocol".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "openai-chat-mode-b-mismatch",
            )
            .expect("scope"),
            request_id: "openai-chat-mode-b-mismatch-1".into(),
            payload,
        },
        &transport,
    )
    .await
    .expect("hosted web_search tool_use must pass through as chat tool_calls");
    assert_eq!(output.status, 200);
    let client_response = match output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => value,
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    let tool_calls = client_response["choices"][0]["message"]["tool_calls"]
        .as_array()
        .expect("hosted web_search must project to chat tool_calls");
    assert_eq!(
        tool_calls[0]["function"]["name"],
        "web_search",
        "hosted web_search server tool must be transparent to the client: {client_response}"
    );
}

#[tokio::test]
async fn openai_chat_sse_mode_b_mismatch_fails_fast_on_delta_websearch_tool_call() {
    // 红测：OpenAiChat wire SSE + 候选 Mode B + 请求侧未激活（无 model）时，
    // provider 在 delta.tool_calls 里返回 websearch call 必须 fail-fast，
    // 禁止静默透传。
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.ws]
bind = "127.0.0.1"
port = 1
routing_group = "ws"
endpoints = ["openai_chat"]
[providers.wschat]
type = "openai_chat"
base_url = "http://wschat.invalid/v1"
default_model = "ws-wire-model"
auth = { type = "api_key", entries = [{ alias = "key1", env = "WS_KEY" }] }
[providers.wschat.models.ws-wire-model]
wire_name = "ws-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.ws.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "wschat", model = "ws-wire-model", key = "key1", priority = 1 }]
[route_groups.ws.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "wschat", model = "ws-wire-model", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();

    struct SseWsMismatchTransport;
    #[async_trait]
    impl ResponsesTransport for SseWsMismatchTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            let stream = futures_util::stream::iter([
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws-m\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_ws\",\"type\":\"function\",\"function\":{\"name\":\"websearch\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n".to_vec()),
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws-m\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"query\\\":\\\"x\\\"}\"}}]},\"finish_reason\":null}]}\n\n".to_vec()),
                Ok(b"data: {\"id\":\"chatcmpl-sse-ws-m\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n".to_vec()),
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

    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "ws".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "openai-chat-sse-mode-b-mismatch",
            )
            .expect("scope"),
            request_id: "openai-chat-sse-mode-b-mismatch-1".into(),
            payload: json!({
                "messages": [{"role": "user", "content": "search the web for x"}],
                "tools": [{"type": "function", "function": {"name": "websearch",
                 "description": "Search the web", "parameters": {"type":"object","properties":{}}}}],
                "stream": true
            }),
        },
        &SseWsMismatchTransport,
    )
    .await
    .expect("relay runtime must return an output");
    // SSE stream 是 lazy 的：guard 错误在 stream 消费时触发，必须消费流断言。
    use futures_util::StreamExt;
    match output.client_body {
        routecodex_v3_runtime::V3OpenAiChatRelayClientBody::Sse(stream) => {
            let events = stream.collect::<Vec<_>>().await;
            let first = events.first().expect("stream must emit an error event");
            let err = first
                .as_ref()
                .expect_err("Mode B SSE mismatch must fail fast");
            assert!(
                err.contains("ROUTECODEX_GOVERNANCE_REJECTED"),
                "expected governance rejection, got: {err}"
            );
        }
        _ => panic!("expected SSE client body"),
    }
}

#[tokio::test]
async fn openai_chat_mode_b_mismatch_with_non_mode_b_forwarder_model_fails_fast() {
    // 复现生产：请求 model 是存在的 forwarder（gpt-5.5 -> cc-sol 非 Mode B），
    // 但 VR 因 web_search 意图路由到 Mode B pool（minimax_anthropic）。
    // 候选 Mode B + 请求侧未激活（forwarder 非 Mode B）→ provider 返回 hosted
    // `web_search` server tool（anthropic wire）→ 按 2026-08-08 语义透传为
    // chat tool_calls 由客户端执行（MEMORY 4241：Chat function calls named
    // web_search project back to web_search_call）；仅本地 `websearch` function
    // tool call 才 fail-fast。
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
endpoints = ["openai_chat"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[providers.text]
type = "openai_chat"
base_url = "http://text.invalid/v1"
default_model = "plain-model"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TXT_KEY" }] }
[providers.text.models.plain-model]
wire_name = "plain-model"
capabilities = ["text", "tools"]
[forwarders."fwd.gpt"]
model = "gpt-5.5"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "text", model = "plain-model", key = "key1", priority = 1 }]
[route_groups.g.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "text", model = "plain-model", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();

    struct WsWireTransport;
    #[async_trait]
    impl ResponsesTransport for WsWireTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                serde_json::to_vec(&json!({
                    "id": "msg_ws_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "MiniMax-M3",
                    "content": [
                        {"type": "tool_use", "id": "call_ws_1", "name": "web_search",
                         "input": {"query": "RouteCodex release"}}
                    ],
                    "stop_reason": "tool_use",
                    "usage": {"input_tokens": 11, "output_tokens": 5}
                }))
                .unwrap(),
            ))
        }
    }

    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "s".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "openai-chat-mode-b-fwd-mismatch",
            )
            .expect("scope"),
            request_id: "openai-chat-mode-b-fwd-mismatch-1".into(),
            payload: json!({
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "search the web for RouteCodex release"}],
                "tools": [{"type": "function", "function": {"name": "websearch",
                 "description": "Search the web", "parameters": {"type":"object","properties":{}}}}],
                "stream": false
            }),
        },
        &WsWireTransport,
    )
    .await
    .expect("hosted web_search tool_use must pass through as chat tool_calls");
    assert_eq!(output.status, 200);
    let client_response = match output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => value,
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    let tool_calls = client_response["choices"][0]["message"]["tool_calls"]
        .as_array()
        .expect("hosted web_search must project to chat tool_calls");
    assert_eq!(
        tool_calls[0]["function"]["name"],
        "web_search",
        "hosted web_search server tool must be transparent to the client: {client_response}"
    );
}

#[tokio::test]
async fn openai_chat_anthropic_sse_minimax_usage_input_tokens_from_message_delta() {
    // MiniMax anthropic 兼容接口的真实流式格式（2026-08-09 线上抓包实证）：
    // message_start 的 usage.input_tokens 是占位 0；真实 input_tokens 在
    // message_delta 的 usage 里（同时带 output_tokens）。transducer 必须从
    // message_delta 覆盖 input_tokens，否则客户端流式 usage prompt_tokens=0。
    use futures_util::StreamExt;
    let manifest = manifest_with_anthropic_multimodal();
    let transport = AnthropicSseTransport {
        captured_url: Mutex::new(None),
        chunks: Mutex::new(Some(vec![br#"event: message_start
data: {"type":"message_start","message":{"id":"msg-mm-usage","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"usage":{"input_tokens":0,"output_tokens":0,"service_tier":"standard"}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":37,"output_tokens":10,"cache_read_input_tokens":128,"service_tier":"standard"}}

event: message_stop
data: {"type":"message_stop"}

"#.to_vec()])),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "cross_protocol".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "chat-anthropic-sse-minimax-usage",
            )
            .expect("scope"),
            request_id: "chat-anthropic-sse-minimax-usage-1".into(),
            payload: json!({
                "model": "deepseek-v4-flash",
                "messages": [{"role":"user","content":[
                    {"type":"text","text":"search news"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}
                ]}],
                "stream": true
            }),
        },
        &transport,
    )
    .await
    .expect("MiniMax Anthropic SSE stream must project lazily and succeed");
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    assert!(
        events.iter().all(Result::is_ok),
        "MiniMax Anthropic stream must not error; events={events:?}"
    );
    let frames: Vec<String> = events
        .into_iter()
        .map(|item| String::from_utf8_lossy(&item.expect("frame")).to_string())
        .collect();
    let joined = frames.concat();
    let usage_chunk = frames
        .iter()
        .find(|frame| frame.contains("\"usage\""))
        .unwrap_or_else(|| panic!("client stream must emit a usage chunk: {joined:?}"));
    assert!(
        usage_chunk.contains("\"prompt_tokens\":37"),
        "MiniMax message_delta input_tokens must override the message_start placeholder zero: {usage_chunk}"
    );
    assert!(
        usage_chunk.contains("\"completion_tokens\":10"),
        "MiniMax message_delta output_tokens must project: {usage_chunk}"
    );
    assert!(
        usage_chunk.contains("\"total_tokens\":47"),
        "MiniMax usage total must sum input+output: {usage_chunk}"
    );
}
