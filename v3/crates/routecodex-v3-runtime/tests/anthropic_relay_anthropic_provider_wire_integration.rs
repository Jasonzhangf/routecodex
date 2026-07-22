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
