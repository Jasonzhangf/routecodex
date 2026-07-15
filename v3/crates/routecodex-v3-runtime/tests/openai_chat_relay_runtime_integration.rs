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
                "choices":[{
                    "index":0,
                    "message":{
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[
                            {"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"alpha\"}"}},
                            {"id":"call_b","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"beta\"}"}}
                        ]
                    },
                    "finish_reason":"tool_calls"
                }],
                "usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn json_runtime_executes_one_hub_lifecycle_and_preserves_chat_semantics() {
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
    assert_eq!(captured["metadata"], payload["metadata"]);
    assert_eq!(output.status, 200);
    assert_eq!(output.node_trace.len(), 15);
    assert_eq!(output.node_trace[0], "V3HubReqInbound01ClientRaw");
    assert_eq!(output.node_trace[14], "V3ServerRespOutbound06ClientFrame");
    let client_response = match output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => value,
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(client_response["choices"][0]["finish_reason"], "tool_calls");
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
capabilities = ["text", "tools", "streaming"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
