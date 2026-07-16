use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_local_continuation, V3ResponsesRelayClientBody,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Mutex};

struct SequentialJsonTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
}

#[async_trait]
impl ResponsesTransport for SequentialJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        let response = self.responses.lock().unwrap().pop_front().unwrap();
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&response).unwrap(),
        ))
    }
}

#[tokio::test]
async fn json_two_turn_restores_tool_call_pairs_output_and_preserves_tools() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_local_1",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_local_1",
                    "name":"lookup",
                    "arguments":"{\"q\":\"alpha\"}"
                }]
            }),
            json!({
                "id":"resp_local_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"alpha result"}]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-local",
        "conversation-local",
        5555,
        "controlled",
    );
    let second_tools = json!([{
        "type":"function",
        "name":"lookup",
        "parameters":{"type":"object","properties":{"q":{"type":"string"}}}
    }]);

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-local-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Lookup alpha"}],
                "tools":second_tools.clone(),
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        1_000,
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "requires_action"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("first turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-local-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_local_1",
                    "output":"alpha"
                }],
                "tools":second_tools.clone(),
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        2_000,
    )
    .await
    .unwrap();
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("second turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(
        captures[1]["input"],
        json!([
            {
                "type":"function_call",
                "call_id":"call_local_1",
                "name":"lookup",
                "arguments":"{\"q\":\"alpha\"}"
            },
            {
                "type":"function_call_output",
                "call_id":"call_local_1",
                "output":"alpha"
            }
        ])
    );
    assert_eq!(captures[1]["tools"], second_tools);
    let provider_wire = serde_json::to_string(&captures[1]).unwrap();
    for forbidden in [
        "session-local",
        "conversation-local",
        "routecodex_local",
        "continuation_owner",
        "metadata_center",
        "store_key",
    ] {
        assert!(
            !provider_wire.contains(forbidden),
            "provider payload leaked {forbidden}"
        );
    }
}

#[tokio::test]
async fn wrong_tool_output_id_fails_before_provider_send_and_keeps_saved_context() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_local_wrong_1",
            "status":"requires_action",
            "output":[{
                "type":"function_call",
                "call_id":"call_saved",
                "name":"lookup",
                "arguments":"{}"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-wrong",
        "conversation-wrong",
        5555,
        "controlled",
    );
    execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-wrong-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":"save context",
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        10_000,
    )
    .await
    .unwrap();
    assert_eq!(state.len().unwrap(), 1);

    let error = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-wrong-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_missing",
                    "output":"wrong"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        11_000,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("not found"));
    assert_eq!(transport.captures.lock().unwrap().len(), 1);
    assert_eq!(state.len().unwrap(), 1);
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
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
