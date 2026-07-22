use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{execute_v3_anthropic_relay_runtime, V3AnthropicRelayRuntimeInput};
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
                "id":"msg_minimax_anthropic",
                "type":"message",
                "role":"assistant",
                "model":"MiniMax-M3",
                "content":[{"type":"text","text":"RCC_V3_MINIMAX_BASIC_OK"}],
                "usage":{"input_tokens":7,"output_tokens":5},
                "stop_reason":"end_turn"
            }))
            .unwrap(),
        ))
    }
}

struct AnthropicProviderSseTextTransport;

#[async_trait]
impl ResponsesTransport for AnthropicProviderSseTextTransport {
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
data: {"type":"message_start","message":{"id":"msg_anthropic_sse","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"usage":{"input_tokens":3}}}

"#.to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#.to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"RCC_V3_ANTHROPIC_"}}

"#.to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"SSE_OK"}}

"#.to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#.to_vec()),
            Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

"#.to_vec()),
            Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#.to_vec()),
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

struct AnthropicProviderSseEofBeforeStopTransport;

#[async_trait]
impl ResponsesTransport for AnthropicProviderSseEofBeforeStopTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let stream = futures_util::stream::iter([
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_anthropic_sse","type":"message","role":"assistant","model":"MiniMax-M3","content":[]}}

"#.to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#.to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}

"#.to_vec()),
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

struct AnthropicProviderJsonToolMissingNameTransport;

#[async_trait]
impl ResponsesTransport for AnthropicProviderJsonToolMissingNameTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"msg_glmrelay_missing_name",
                "type":"message",
                "role":"assistant",
                "model":"glm-5.2",
                "content":[{
                    "type":"tool_use",
                    "id":"call_missing_name",
                    "input":{"query":"ping"}
                }],
                "stop_reason":"tool_use"
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn anthropic_relay_selected_anthropic_provider_uses_anthropic_messages_wire() {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-anthropic-anthropic-provider-wire".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "max_tokens":64,
                "messages":[{"role":"user","content":"Return exactly: RCC_V3_MINIMAX_BASIC_OK"}],
                "stream":false
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
    assert_eq!(output.client_response["id"], "msg_minimax_anthropic");
    assert_eq!(output.client_response["content"][0]["type"], "text");
    assert_eq!(
        output.client_response["content"][0]["text"],
        "RCC_V3_MINIMAX_BASIC_OK"
    );
    assert_eq!(output.client_response["stop_reason"], "end_turn");
}

#[tokio::test]
async fn anthropic_relay_stream_request_projects_json_provider_body_as_sse_events() {
    let transport = AnthropicProviderJsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-anthropic-json-body-client-sse".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "max_tokens":64,
                "messages":[{"role":"user","content":"Return exactly: RCC_V3_MINIMAX_BASIC_OK"}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    let events = output.client_response["events"]
        .as_array()
        .expect("stream=true Anthropic client projection must contain SSE events");
    assert_eq!(events.first().unwrap()["event"], "message_start");
    assert!(events.iter().any(
        |event| event.pointer("/data/delta/text").and_then(Value::as_str)
            == Some("RCC_V3_MINIMAX_BASIC_OK")
    ));
    assert_eq!(events.last().unwrap()["event"], "message_stop");
}

#[tokio::test]
async fn anthropic_relay_anthropic_provider_sse_reaches_client_sse_events() {
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-anthropic-provider-sse".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "max_tokens":64,
                "messages":[{"role":"user","content":"Return exactly: RCC_V3_ANTHROPIC_SSE_OK"}],
                "stream":true
            }),
        },
        &AnthropicProviderSseTextTransport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    assert_eq!(output.node_trace.len(), 17, "trace={:?}", output.node_trace);
    let events = output.client_response["events"]
        .as_array()
        .expect("Anthropic provider SSE must project to Anthropic client SSE events");
    assert_eq!(events.first().unwrap()["event"], "message_start");
    assert!(events.iter().any(
        |event| event.pointer("/data/delta/text").and_then(Value::as_str)
            == Some("RCC_V3_ANTHROPIC_SSE_OK")
    ));
    assert_eq!(events.last().unwrap()["event"], "message_stop");
}

#[tokio::test]
async fn anthropic_relay_anthropic_provider_sse_eof_before_message_stop_fails() {
    let error = execute_v3_anthropic_relay_runtime(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-anthropic-provider-sse-eof".into(),
            payload: json!({
                "model":"MiniMax-M3",
                "max_tokens":64,
                "messages":[{"role":"user","content":"partial stream"}],
                "stream":true
            }),
        },
        &AnthropicProviderSseEofBeforeStopTransport,
    )
    .await
    .unwrap_err();

    let message = error.to_string();
    assert!(
        message.contains("Anthropic provider SSE ended without message_stop"),
        "unexpected error: {message}"
    );
    assert!(
        !message.contains("not implemented"),
        "runtime must execute the Anthropic provider SSE decoder, not the old unimplemented branch"
    );
}

#[tokio::test]
async fn anthropic_relay_anthropic_provider_tool_use_missing_name_fails_without_inference() {
    let error = execute_v3_anthropic_relay_runtime(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "gateway_priority_5555".into(),
            request_id: "req-anthropic-provider-tool-missing-name".into(),
            payload: json!({
                "model":"glm-5.2",
                "max_tokens":64,
                "messages":[{"role":"user","content":"Use lookup_test with query=\"ping\"."}],
                "tools":[{
                    "name":"lookup_test",
                    "description":"Return test lookup result",
                    "input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
                }],
                "tool_choice":{"type":"tool","name":"lookup_test"},
                "stream":false
            }),
        },
        &AnthropicProviderJsonToolMissingNameTransport,
    )
    .await
    .unwrap_err();

    let message = error.to_string();
    assert!(
        message.contains("missing name/function.name"),
        "provider tool_use without name must fail-fast instead of inferring from tool_choice: {message}"
    );
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
