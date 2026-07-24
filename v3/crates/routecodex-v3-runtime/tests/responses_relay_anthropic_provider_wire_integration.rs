use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime, V3ResponsesRelayClientBody, V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Mutex;

struct AnthropicProviderJsonTransport {
    captured_url: Mutex<Option<String>>,
    captured_body: Mutex<Option<Value>>,
}

#[async_trait]
impl ResponsesTransport for AnthropicProviderJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured_url.lock().unwrap() = Some(request.url().to_string());
        *self.captured_body.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"msg_minimax_json",
                "type":"message",
                "role":"assistant",
                "model":"MiniMax-M3",
                "content":[
                    {"type":"thinking","thinking":"basic plan"},
                    {"type":"text","text":"RCC_V3_MINIMAX_BASIC_OK"}
                ],
                "usage":{"input_tokens":7,"output_tokens":5},
                "stop_reason":"end_turn"
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn responses_relay_selected_anthropic_provider_uses_anthropic_messages_wire() {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-anthropic-provider-wire".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "input":[{"role":"user","content":[{"type":"input_text","text":"Return exactly: RCC_V3_MINIMAX_BASIC_OK"}]}],
                "stream":false,
                "max_output_tokens":64
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(
        transport.captured_url.lock().unwrap().as_deref(),
        Some("http://controlled.invalid/anthropic/v1/messages")
    );
    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    assert_eq!(captured["model"], "MiniMax-M3");
    assert_eq!(captured["max_tokens"], 64);
    assert_eq!(captured["stream"], false);
    assert_eq!(
        captured["messages"],
        json!([{"role":"user","content":[{"type":"text","text":"Return exactly: RCC_V3_MINIMAX_BASIC_OK"}]}])
    );
    assert!(captured.get("input").is_none());
    assert!(captured.get("max_output_tokens").is_none());

    assert_eq!(output.status, 200);
    let client = match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => value,
        V3ResponsesRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(client["id"], "msg_minimax_json");
    assert_eq!(client["status"], "completed");
    assert_eq!(client["output"][0]["type"], "reasoning");
    assert_eq!(client["output"][0]["summary"][0]["text"], "basic plan");
    assert_eq!(client["output"][1]["role"], "assistant");
    assert_eq!(
        client["output"][1]["content"][0]["text"],
        "RCC_V3_MINIMAX_BASIC_OK"
    );
    assert_eq!(client["usage"]["input_tokens"], 7);
    assert_eq!(client["usage"]["output_tokens"], 5);
    assert_eq!(client["usage"]["total_tokens"], 12);
}

#[tokio::test]
async fn responses_relay_reasoning_request_config_reaches_anthropic_provider_as_thinking() {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-reasoning-to-anthropic-thinking".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "input":[{"role":"user","content":[{"type":"input_text","text":"Use reasoning before answer"}]}],
                "reasoning":{"effort":"medium","summary":"detailed"},
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    assert_eq!(
        captured["thinking"],
        json!({"type":"enabled","budget_tokens":4096})
    );
    assert!(
        captured.get("reasoning").is_none(),
        "Anthropic provider request must receive thinking, not Responses reasoning: {captured}"
    );
}

#[tokio::test]
async fn responses_relay_string_input_reasoning_request_config_reaches_anthropic_provider_as_thinking(
) {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-string-reasoning-to-anthropic-thinking".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "input":"Use reasoning before answering this string-input request",
                "reasoning":{"effort":"medium","summary":"detailed"},
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    assert_eq!(
        captured["thinking"],
        json!({"type":"enabled","budget_tokens":4096})
    );
    assert!(
        captured.get("reasoning").is_none(),
        "Anthropic provider request must receive thinking for string input without leaking Responses reasoning: {captured}"
    );
}

struct AnthropicProviderJsonReasoningTransport;

#[async_trait]
impl ResponsesTransport for AnthropicProviderJsonReasoningTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        assert_eq!(
            request.url(),
            "http://controlled.invalid/anthropic/v1/messages"
        );
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"msg_minimax_json_reasoning",
                "type":"message",
                "role":"assistant",
                "model":"MiniMax-M3",
                "content":[
                    {"type":"thinking","thinking":"plan before answer","signature":"sig-json-1"},
                    {"type":"text","text":"answer"}
                ],
                "usage":{"input_tokens":7,"output_tokens":5},
                "stop_reason":"end_turn"
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn responses_relay_anthropic_provider_json_preserves_thinking_to_responses_reasoning() {
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-anthropic-json-reasoning".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "input":[{"role":"user","content":[{"type":"input_text","text":"reason"}]}],
                "stream":false
            }),
        },
        &AnthropicProviderJsonReasoningTransport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    let client = match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => value,
        V3ResponsesRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(client["output"][0]["type"], "reasoning");
    assert_eq!(
        client["output"][0]["summary"][0]["text"],
        "plan before answer"
    );
    assert_eq!(client["output"][0]["encrypted_content"], "sig-json-1");
    assert_eq!(client["output"][1]["content"][0]["text"], "answer");
}

struct AnthropicProviderSseReasoningTransport;

#[async_trait]
impl ResponsesTransport for AnthropicProviderSseReasoningTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        assert_eq!(
            request.url(),
            "http://controlled.invalid/anthropic/v1/messages"
        );
        let stream = futures_util::stream::iter([
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_sse_reasoning","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"usage":{"input_tokens":3,"output_tokens":4}}}

"#.to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"redacted-sse-1"}}

"#.to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#.to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":"plan "}}

"#.to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"step"}}

"#.to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"thinking-sse-sig"}}

"#.to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":1}

"#.to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":"done"}}

"#.to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":2}

"#.to_vec()),
            Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}

"#.to_vec()),
            Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#.to_vec()),
            Ok(b"data: [DONE]

".to_vec()),
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
async fn responses_relay_anthropic_provider_sse_preserves_reasoning_encrypted_content_to_responses_client(
) {
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-anthropic-sse-reasoning".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "input":[{"role":"user","content":[{"type":"input_text","text":"reason"}]}],
                "stream":true,
                "max_output_tokens":64
            }),
        },
        &AnthropicProviderSseReasoningTransport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            use futures_util::StreamExt;
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("projected Anthropic provider SSE chunk"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(
                text.contains("\"type\":\"reasoning\""),
                "Responses SSE must contain reasoning output items: {text}"
            );
            assert!(
                text.contains("redacted-sse-1"),
                "redacted_thinking.data must become Responses reasoning.encrypted_content: {text}"
            );
            assert!(text.contains("thinking-sse-sig"), "thinking signature_delta must become Responses reasoning.encrypted_content: {text}");
            assert!(
                text.contains("plan step"),
                "thinking text must remain Responses reasoning.summary text: {text}"
            );
            assert!(text.contains("event: response.completed"));
            assert!(text.contains("event: response.done"));
            assert!(text.contains("data: [DONE]"));
            assert!(
                !text.contains("redacted_thinking"),
                "provider-wire redacted_thinking must not leak to Responses client payload: {text}"
            );
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("stream request must project SSE body"),
    }
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3

[servers.gateway_priority_5555]
bind = "127.0.0.1"
port = 5555
routing_group = "gateway_priority_5555"
endpoints = ["responses", "anthropic"]

[providers.minimax]
type = "anthropic"
base_url = "http://controlled.invalid/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_TEST_KEY" }] }

[providers.minimax.models.MiniMax-M3]
wire_name = "MiniMax-M3"
supports_streaming = true
capabilities = ["text", "tools", "reasoning", "vision", "longcontext"]

[route_groups.gateway_priority_5555.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
