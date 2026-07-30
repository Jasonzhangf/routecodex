use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime, execute_v3_responses_relay_runtime_with_retry_policy,
    V3ResponsesRelayClientBody, V3ResponsesRelayRetryPolicy, V3ResponsesRelayRuntimeInput,
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

struct AnthropicProviderProjectionTransport {
    captured_projection: Mutex<Option<Value>>,
}

#[async_trait]
impl ResponsesTransport for AnthropicProviderProjectionTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured_projection.lock().unwrap() =
            Some(request.redacted_provider_request_projection());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"msg_claude_code_compat",
                "type":"message",
                "role":"assistant",
                "model":"claude-fable-5",
                "content":[{"type":"text","text":"OK"}],
                "usage":{"input_tokens":7,"output_tokens":1},
                "stop_reason":"end_turn"
            }))
            .unwrap(),
        ))
    }
}

struct AnthropicCyberRefusalThenSuccessTransport {
    attempts: Mutex<usize>,
}

#[async_trait]
impl ResponsesTransport for AnthropicCyberRefusalThenSuccessTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let attempt = {
            let mut attempts = self.attempts.lock().unwrap();
            *attempts += 1;
            *attempts
        };
        if attempt == 1 {
            let frames: Vec<Result<Vec<u8>, V3ProviderError>> = vec![
                Ok("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_refusal\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".as_bytes().to_vec()),
                Ok("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\",\"stop_details\":{\"type\":\"refusal\",\"category\":\"cyber\",\"explanation\":\"policy\"}}}\n\n".as_bytes().to_vec()),
            ];
            return Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(futures_util::stream::iter(frames)),
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
                "id":"msg_after_cyber_retry",
                "type":"message",
                "role":"assistant",
                "model":"claude-fable-5",
                "content":[{"type":"text","text":"OK after retry"}],
                "usage":{"input_tokens":7,"output_tokens":3},
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
                "max_output_tokens":64,
                "user":"anthropic-user-1"
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(
        transport.captured_url.lock().unwrap().as_deref(),
        Some("http://controlled.invalid/anthropic/v1/messages?beta=true")
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
    assert!(captured.get("user").is_none());
    assert_eq!(captured["metadata"], json!({"user_id":"anthropic-user-1"}));

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
async fn responses_relay_claude_anthropic_provider_uses_claude_code_prompt_and_headers() {
    let transport = AnthropicProviderProjectionTransport {
        captured_projection: Mutex::new(None),
    };
    let output = execute_v3_responses_relay_runtime(
        &claude_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "anthropic_v3_10000".into(),
            request_id: "req-responses-claude-code-compat".into(),
            payload: json!({
                "model":"claude-fable-5",
                "input":"Reply OK only.",
                "instructions":"this request instruction must be replaced by Claude Code prompt",
                "stream":false,
                "max_output_tokens":16
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    let projection = transport
        .captured_projection
        .lock()
        .unwrap()
        .clone()
        .expect("provider request projection");
    assert_eq!(
        projection["url"],
        "http://controlled.invalid/anthropic/v1/messages?beta=true"
    );
    let headers = &projection["headers"];
    assert_eq!(headers["authorization"], "[REDACTED]");
    assert_eq!(headers["x-api-key"], "[REDACTED]");
    assert_eq!(headers["anthropic-version"], "2023-06-01");
    assert_eq!(
        headers["user-agent"],
        "claude-cli/2.1.220 (external, sdk-cli)"
    );
    assert!(headers["anthropic-beta"]
        .as_str()
        .is_some_and(|value| value.contains("claude-code-20250219")));
    assert_eq!(headers["anthropic-dangerous-direct-browser-access"], "true");
    assert_eq!(headers["x-app"], "cli");
    assert_eq!(headers["x-stainless-lang"], "js");
    assert_eq!(headers["x-stainless-package-version"], "0.94.0");
    assert_eq!(headers["x-stainless-runtime"], "node");
    assert_eq!(headers["x-stainless-retry-count"], "0");
    assert_eq!(headers["x-stainless-timeout"], "300");

    let system = projection["body"]["system"]
        .as_array()
        .expect("Claude Code prompt system blocks");
    assert_eq!(
        system[0]["text"],
        "x-anthropic-billing-header: cc_version=2.1.220.dae; cc_entrypoint=sdk-cli;"
    );
    assert_eq!(system[1]["cache_control"], json!({"type":"ephemeral"}));
    assert_eq!(system[2]["cache_control"], json!({"type":"ephemeral"}));
    assert!(system[2]["text"].as_str().is_some_and(|text| text.contains(
        "You are an interactive agent that helps users with software engineering tasks."
    )));
    assert!(system[2]["text"]
        .as_str()
        .is_some_and(|text| text.contains("/tmp/claude-code-standard-capture-1785077403/work")));
    assert!(!system[2]["text"]
        .as_str()
        .is_some_and(|text| text.contains("claude-code-capture.kJhuye")));
    let serialized = serde_json::to_string(&projection["body"]).unwrap();
    assert!(
        !serialized.contains("this request instruction must be replaced"),
        "Claude Code system prompt must replace the request system: {projection}"
    );
}

#[tokio::test]
async fn responses_relay_anthropic_cyber_refusal_sse_is_retryable_provider_failure() {
    let transport = AnthropicCyberRefusalThenSuccessTransport {
        attempts: Mutex::new(0),
    };
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &claude_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "anthropic_v3_10000".into(),
            request_id: "req-responses-anthropic-cyber-refusal-retry".into(),
            payload: json!({
                "model":"claude-fable-5",
                "input":"Reply OK only.",
                "stream":true,
                "max_output_tokens":16
            }),
        },
        &transport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 1,
        },
    )
    .await
    .unwrap();

    assert_eq!(*transport.attempts.lock().unwrap(), 2);
    assert_eq!(output.status, 200);
    let observability = output.observability.as_ref().expect("observability");
    assert_eq!(observability.provider_failure_events.len(), 1);
    let failure = &observability.provider_failure_events[0];
    assert_eq!(failure.status, 429);
    assert_eq!(failure.error_type.as_deref(), Some("rate_limit_error"));
    assert!(failure
        .message
        .contains("Anthropic cyber refusal is treated as retryable provider saturation"));
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            use futures_util::StreamExt;
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("projected retry success SSE chunk"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(text.contains("OK after retry"));
            assert!(!text.contains("ANTHROPIC_CYBER_REFUSAL"));
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("stream request must project SSE body"),
    }
}

#[tokio::test]
async fn responses_relay_anthropic_provider_rejects_unmappable_metadata() {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-anthropic-provider-unmappable-metadata".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "input":[{"role":"user","content":[{"type":"input_text","text":"metadata"}]}],
                "stream":false,
                "metadata":{"client":"not-anthropic-wire-compatible"}
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 502);
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
    let observability = output.observability.as_ref().expect("observability");
    assert!(observability.provider_failure_events.iter().all(|failure| {
        failure.error_type.as_deref() == Some("provider_request_compat_error")
            && failure.message.contains("metadata.unsupported")
    }), "unmappable Responses metadata must be projected through the provider error chain: {observability:?}");
    assert!(transport.captured_body.lock().unwrap().is_none());
}

#[tokio::test]
async fn responses_relay_reasoning_request_config_projects_anthropic_system_marker() {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-reasoning-to-anthropic-marker".into(),
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
    assert!(
        captured.get("thinking").is_none(),
        "Anthropic provider request must not synthesize thinking budget from Responses effort/summary: {captured}"
    );
    assert!(
        captured.get("reasoning").is_none(),
        "Anthropic provider request must not leak Responses reasoning object: {captured}"
    );
    assert!(
        captured["system"].as_str().is_some_and(|system| system.contains("<routecodex_reasoning_request summary_policy=detailed></routecodex_reasoning_request>")),
        "Anthropic compatible projection must preserve summary policy as target-valid system marker: {captured}"
    );
}

#[tokio::test]
async fn responses_relay_string_input_reasoning_request_config_projects_anthropic_system_marker() {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-responses-string-reasoning-to-anthropic-marker".into(),
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
    assert!(
        captured.get("thinking").is_none(),
        "Anthropic provider request must not synthesize thinking budget from Responses effort/summary for string input: {captured}"
    );
    assert!(
        captured.get("reasoning").is_none(),
        "Anthropic provider request must not leak Responses reasoning for string input: {captured}"
    );
    assert!(
        captured["system"].as_str().is_some_and(|system| system.contains("<routecodex_reasoning_request summary_policy=detailed></routecodex_reasoning_request>")),
        "Anthropic compatible projection must preserve string-input summary policy as target-valid system marker: {captured}"
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
            "http://controlled.invalid/anthropic/v1/messages?beta=true"
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
            "http://controlled.invalid/anthropic/v1/messages?beta=true"
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

fn claude_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3

[servers.anthropic_v3_10000]
bind = "127.0.0.1"
port = 10000
routing_group = "anthropic_v3_10000"
endpoints = ["responses"]

[providers.modrouter_anthropic]
type = "anthropic"
base_url = "http://controlled.invalid/anthropic"
default_model = "claude-fable-5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MODROUTER_ANTHROPIC_TEST_KEY" }] }
health = { enabled = false, failure_threshold = 3, cooldown_ms = 30000 }

[providers.modrouter_anthropic.models."claude-fable-5"]
wire_name = "claude-fable-5"
supports_streaming = true
capabilities = ["text", "tools", "web_search", "longcontext", "multimodal", "vision"]

[route_groups.anthropic_v3_10000.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "modrouter_anthropic", model = "claude-fable-5", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
