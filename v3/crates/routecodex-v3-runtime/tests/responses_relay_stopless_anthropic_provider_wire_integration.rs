use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayLocalStoplessControlInput, V3ResponsesRelayProviderHealthHandle,
    V3ResponsesRelayRuntimeInput, V3ResponsesRelayStoplessControlState,
};
use serde_json::{json, Value};
use std::sync::Mutex;

struct CaptureAnthropicTransport {
    captures: Mutex<Vec<Value>>,
}

#[async_trait]
impl ResponsesTransport for CaptureAnthropicTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push(request.redacted_provider_request_projection());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"msg_stopless_cleanup",
                "type":"message",
                "role":"assistant",
                "model":"MiniMax-M3",
                "content":[{"type":"text","text":"continued"}],
                "usage":{"input_tokens":7,"output_tokens":1},
                "stop_reason":"end_turn"
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn responses_direct_to_relay_req04_strips_all_historical_stopless_pairs_before_anthropic_wire(
) {
    let manifest = manifest();
    let transport = CaptureAnthropicTransport {
        captures: Mutex::new(Vec::new()),
    };
    let continuation = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "019fa867-f81f-7652-b58f-2290fa2cc98b",
        "zterm-stopless-duplicate",
        5555,
        "responses_v3_5555",
    );

    let result = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "responses_v3_5555".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "responses_v3_5555",
                "responses_v3_5555",
                concat!(module_path!(), ":", line!()),
            )
            .expect("provider failure scope"),
            request_id: "req-direct-relay-stopless-duplicate".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"继续真实目标"}]},
                    {"type":"function_call","call_id":"call_real_history","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"},
                    {"type":"function_call_output","call_id":"call_real_history","output":"/workspace"},
                    {"type":"function_call","id":"fc_stopless_old_1","call_id":"call_stopless_reasoning","name":"exec_command","arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"},
                    {"type":"function_call_output","id":"fco_stopless_old_1","call_id":"call_stopless_reasoning","output":"Chunk ID: old-1\nProcess exited with code 0"},
                    {"type":"function_call","id":"fc_stopless_old_2","call_id":"call_stopless_reasoning","name":"exec_command","arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"},
                    {"type":"function_call_output","id":"fco_stopless_old_2","call_id":"call_stopless_reasoning","output":"Chunk ID: old-2\nProcess exited with code 0"}
                ]
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &continuation,
            &stopless_control,
            scope,
            13_000,
        ),
    )
    .await;

    let output = result.expect(
        "Req04 must remove stale stopless pairs before Anthropic provider compatibility validation",
    );
    assert!(
        output.node_trace.contains(&"V3HubReqChatProcess04Governed"),
        "Direct-to-Relay handoff must pass through Req04: {:?}",
        output.node_trace
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "Anthropic provider must be sent once");
    let provider_body = captures[0].get("body").expect("provider projection body");
    let serialized = serde_json::to_string(provider_body).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID: old-1",
        "Chunk ID: old-2",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "Req04 leaked historical stopless artifact {forbidden} to Anthropic wire: {serialized}"
        );
    }
    assert!(
        serialized.contains("call_real_history"),
        "Req04 cleanup must preserve real tool history: {serialized}"
    );
    assert!(
        serialized.contains("/workspace"),
        "Req04 cleanup must preserve real tool output: {serialized}"
    );
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.responses_v3_5555]
bind = "127.0.0.1"
port = 5555
routing_group = "responses_v3_5555"
endpoints = ["responses"]
features = { stopless_center = true }
[providers.minimax_anthropic]
type = "anthropic"
base_url = "http://controlled.invalid/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_TEST_KEY" }] }
[providers.minimax_anthropic.models.MiniMax-M3]
wire_name = "MiniMax-M3"
supports_streaming = true
capabilities = ["text", "tools", "reasoning", "longcontext"]
[route_groups.responses_v3_5555.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax_anthropic", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
