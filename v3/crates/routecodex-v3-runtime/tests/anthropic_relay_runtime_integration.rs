use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_anthropic_relay_runtime, project_v3_responses_sse_as_anthropic_events,
    V3AnthropicRelayRuntimeInput,
};
use serde_json::json;
use std::sync::Mutex;

struct JsonTransport {
    captured: Mutex<Option<serde_json::Value>>,
}

#[async_trait]
impl ResponsesTransport for JsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_json_1",
                "status":"completed",
                "output":[
                    {"type":"reasoning","summary":[{"type":"summary_text","text":"Need lookup"}]},
                    {"type":"function_call","call_id":"call_json_1","name":"lookup","arguments":"{\"q\":\"alpha\"}"}
                ]
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn json_runtime_uses_one_fixed_hub_lifecycle_and_exact_provider_wire() {
    let transport = JsonTransport {
        captured: Mutex::new(None),
    };
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-json".into(),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"Lookup alpha"}],
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
                "thinking":{"type":"enabled","budget_tokens":512},
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(
        transport.captured.lock().unwrap().as_ref().unwrap(),
        &json!({
            "model":"responses-wire-model",
            "input":[{"role":"user","content":[{"type":"input_text","text":"Lookup alpha"}]}],
            "tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}],
            "reasoning":{"effort":"medium"},
            "stream":false
        })
    );
    assert_eq!(output.status, 200);
    assert_eq!(output.node_trace.len(), 15);
    assert_eq!(output.node_trace[0], "V3HubReqInbound01ClientRaw");
    assert_eq!(output.node_trace[14], "V3ServerRespOutbound06ClientFrame");
    assert_eq!(output.client_response["stop_reason"], "tool_use");
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
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-error".into(),
            payload: json!({"model":"alias","messages":[{"role":"user","content":"fail"}],"stream":false}),
        },
        &ErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 429);
    assert_eq!(output.client_response["type"], "error");
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
}

#[tokio::test]
async fn structured_sse_contract_preserves_reasoning_tool_and_terminal_order() {
    let stream = futures_util::stream::iter([
        Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"Need".to_vec()),
        Ok(b" beta\"}\n\n".to_vec()),
        Ok(b"event: response.output_item.added\ndata: {\"item\":{\"type\":\"function_call\",\"call_id\":\"call_sse_1\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n".to_vec()),
        Ok(b"event: response.function_call_arguments.delta\ndata: {\"delta\":\"{\\\"q\\\":\\\"beta\\\"}\"}\n\n".to_vec()),
        Ok(b"event: response.completed\ndata: {\"response\":{\"id\":\"resp_sse_1\",\"status\":\"completed\"}}\n\n".to_vec()),
    ]);
    let projection = project_v3_responses_sse_as_anthropic_events(Box::pin(stream))
        .await
        .unwrap();
    let (canonical_response, client_events) = projection.into_parts();
    assert_eq!(canonical_response["output"].as_array().unwrap().len(), 2);
    let client =
        routecodex_v3_runtime::V3AnthropicRelaySseProjection::project_after_resp04(client_events);
    let events = client["events"].as_array().unwrap();
    assert_eq!(events.len(), 5);
    assert_eq!(events.last().unwrap()["event"], "message_stop");
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
