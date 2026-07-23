use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_openai_chat_relay_runtime, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Mutex;

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
    let transport = ReselectTransport {
        provider_ids: Mutex::new(Vec::new()),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest_with_two_providers(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
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
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
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

type ControlledSseReceiver = tokio::sync::mpsc::Receiver<Result<Vec<u8>, V3ProviderError>>;

struct ControlledSseTransport {
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
    ];
    for (chunks, expected) in cases {
        let transport = StaticSseTransport {
            chunks: Mutex::new(Some(chunks)),
        };
        let output = execute_v3_openai_chat_relay_runtime(
            &manifest(),
            V3OpenAiChatRelayRuntimeInput {
                server_id: "controlled".into(),
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
async fn request_side_channel_is_rejected_before_provider_transport() {
    let error = execute_v3_openai_chat_relay_runtime(
        &manifest(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
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
capabilities = ["text", "tools"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_with_two_providers() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
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
capabilities = ["text", "tools"]
[providers.secondary]
type = "openai_chat"
base_url = "http://secondary.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "secondary", env = "V3_OPENAI_CHAT_SECONDARY_KEY" }] }
[providers.secondary.models.chat-wire-model]
wire_name = "chat-wire-model"
aliases = ["chat-client-alias"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "chat-wire-model", key = "primary", priority = 1 },
  { kind = "provider_model", provider = "secondary", model = "chat-wire-model", key = "secondary", priority = 2 }
]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
