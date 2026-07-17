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
async fn json_two_turn_apply_patch_uses_freeform_projection_and_error_feedback() {
    let patch = "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch";
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_apply_patch_1",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_apply_patch_freeform",
                    "name":"apply_patch",
                    "arguments": serde_json::to_string(&json!({"patch": patch})).unwrap()
                }]
            }),
            json!({
                "id":"resp_apply_patch_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"retry received"}]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-apply-patch",
        "conversation-apply-patch",
        5555,
        "controlled",
    );

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-apply-patch-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Patch a file"}],
                "tools":[{"type":"custom","name":"apply_patch","format":"freeform"}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        20_000,
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action");
            assert_eq!(body["output"][0]["type"], "custom_tool_call");
            assert_eq!(body["output"][0]["name"], "apply_patch");
            assert_eq!(body["output"][0]["call_id"], "call_apply_patch_freeform");
            assert_eq!(body["output"][0]["input"], patch);
            assert!(body["output"][0].get("arguments").is_none());
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("first turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-apply-patch-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"custom_tool_call_output",
                    "call_id":"call_apply_patch_freeform",
                    "output":"apply_patch verification failed: invalid patch for /tmp/codex-patch-test/new.txt"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        21_000,
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
    assert_eq!(captures[1]["input"][0]["type"], "custom_tool_call");
    assert_eq!(captures[1]["input"][0]["name"], "apply_patch");
    assert_eq!(captures[1]["input"][0]["input"], patch);
    assert_eq!(captures[1]["input"][1]["type"], "custom_tool_call_output");
    let feedback = captures[1]["input"][1]["output"].as_str().unwrap();
    assert!(feedback.starts_with("APPLY_PATCH_ERROR: apply_patch did not apply"));
    assert!(feedback.contains("Retry with apply_patch only"));
    assert!(!feedback.contains("/tmp/codex-patch-test"));
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

#[tokio::test]
async fn full_history_paired_tool_output_does_not_require_local_restore() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_full_history_2",
            "status":"completed",
            "output":[{"type":"output_text","text":"full history ok"}]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "request:req-full-history",
        "request:req-full-history",
        5555,
        "controlled",
    );

    let response = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-full-history".into(),
            payload: json!({
                "model":"client-responses",
                "previous_response_id":"1a3e546c-0a32-4667-933c-03f88aafc05c",
                "input":[
                    {"role":"user","content":"Lookup alpha"},
                    {
                        "type":"function_call",
                        "call_id":"call_full_history",
                        "name":"lookup",
                        "arguments":"{\"q\":\"alpha\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_full_history",
                        "output":"alpha"
                    }
                ],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        20_000,
    )
    .await
    .unwrap();
    match response.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("full-history replay must be JSON"),
    }
    assert!(state.is_empty().unwrap());
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_eq!(captures[0]["input"][1]["call_id"], "call_full_history");
    assert_eq!(captures[0]["input"][2]["call_id"], "call_full_history");
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
