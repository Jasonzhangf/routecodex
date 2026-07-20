use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_provider_resp_inbound_01_raw,
    compile_v3_hub_relay_request_hooks, compile_v3_hub_relay_response_hooks,
    execute_v3_responses_relay_runtime, V3HubContinuationLookup, V3HubContinuationOwnership,
    V3HubContinuationScope, V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource,
    V3HubProviderWireProtocol, V3HubRelayResponseHookProfile, V3HubServertoolRequestProfile,
    V3HubTransportIntent, V3ResponsesRelayClientBody, V3ResponsesRelayRuntimeInput,
    V3StoplessCenterState, V3StoplessCenterSteering,
};
use serde_json::{json, Value};
use std::sync::Mutex;

fn relay_response(payload: Value) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    )
}

fn raw_request(payload: Value) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    build_v3_hub_req_inbound_01_client_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    )
}

fn scope() -> V3HubContinuationScope {
    V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        "server-a",
        "group-a",
        "session-a",
    )
}

fn stopless_call(payload: &Value) -> &Value {
    payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| item.get("call_id").and_then(Value::as_str) == Some("call_stopless_reasoning"))
        .expect("stopless no-op call")
}

fn stopless_cmd(payload: &Value) -> String {
    let arguments = stopless_call(payload)
        .get("arguments")
        .and_then(Value::as_str)
        .expect("stopless call arguments");
    serde_json::from_str::<Value>(arguments)
        .expect("stopless arguments JSON")
        .get("cmd")
        .and_then(Value::as_str)
        .expect("stopless cmd")
        .to_string()
}

#[test]
fn natural_stop_projects_noop_cli_without_cli_state_json() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_natural_stop_noop",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"自然停下的可见文本"}]
            }]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.finalized_payload();

    assert_eq!(payload["status"], "requires_action");
    assert_eq!(stopless_cmd(payload), "routecodex hook run reasoningStop");
    let serialized = serde_json::to_string(payload).unwrap();
    for forbidden in [
        "--input-json",
        "repeatCount",
        "maxRepeats",
        "triggerHint",
        "schemaFeedback",
        "<rcc_stop_schema>",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "no-op stopless projection leaked old CLI/schema state {forbidden}: {serialized}"
        );
    }
    assert!(
        serialized.contains("自然停下的可见文本"),
        "client-visible assistant text must survive natural-stop projection: {serialized}"
    );
}

#[test]
fn assistant_text_stop_schema_fence_is_not_a_stopless_state_source() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(json!({
            "id":"resp_fence_ignored",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text":"旧正文 schema 不再是状态源\n<rcc_stop_schema>{\"stopreason\":0,\"has_evidence\":1,\"evidence\":\"old fence\"}</rcc_stop_schema>"
                }]
            }]
        })))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = hooks.commit(resp03).unwrap();

    assert_eq!(
        resp04.finalized_payload()["status"],
        "requires_action",
        "assistant text/fence must be treated as natural stop unless reasoningStop updated StoplessCenter"
    );
    assert_eq!(
        stopless_cmd(resp04.finalized_payload()),
        "routecodex hook run reasoningStop"
    );
}

#[test]
fn request_consumes_noop_cli_and_uses_runtime_control_not_stdout() {
    let restored_context = json!({
        "input": [
            {"role":"user","content":"完成当前目标"},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"自然停下的可见文本"}]},
            {
                "type":"function_call",
                "call_id":"call_stopless_reasoning",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
            }
        ],
        "output": [{
            "type":"function_call",
            "call_id":"call_stopless_reasoning",
            "name":"exec_command",
            "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
        }]
    });
    let lookup = V3HubContinuationLookup::new(Some("ctx-stopless-center"), scope())
        .with_local_context("ctx-stopless-center", scope(), restored_context);
    let outcome = compile_v3_hub_relay_request_hooks()
        .run(
            raw_request(json!({
                "model":"gpt-5.5",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":""
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop().with_stopless_center_state(
                V3StoplessCenterState::new(
                    1,
                    3,
                    V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
                ),
            ),
        )
        .unwrap();
    let payload = outcome.payload();
    let serialized = serde_json::to_string(payload).unwrap();

    assert_eq!(
        payload["input"],
        json!([{"role":"user","content":"完成当前目标"}])
    );
    assert!(
        payload["instructions"]
            .as_str()
            .unwrap_or_default()
            .contains("继续完成当前目标"),
        "StoplessCenter steering must be short and provider-facing in instructions: {serialized}"
    );
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID",
        "repeatCount",
        "schemaFeedback",
        "<rcc_stop_schema>",
        "stop schema",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider request leaked old stopless CLI/schema payload {forbidden}: {serialized}"
        );
    }
}

struct CaptureJsonTransport {
    captures: Mutex<Vec<Value>>,
    response: Value,
}

#[async_trait]
impl ResponsesTransport for CaptureJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.response).unwrap(),
        ))
    }
}

fn manifest_with_stopless_center(
    enabled: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&format!(
            r#"
version = 3
[features]
stopless_center = {enabled}
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[providers.controlled]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "responses-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "CONTROLLED_KEY" }}] }}
[providers.controlled.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning", "streaming"]
[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }}]
"#
        ))
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn feature_toggle_false_disables_relay_stopless_injection_and_projection() {
    let manifest = manifest_with_stopless_center(false);
    let transport = CaptureJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_stopless_disabled",
            "object":"response",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"natural stop should pass when disabled"}]
            }]
        }),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".to_string(),
            request_id: "req-stopless-disabled".to_string(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"stopless disabled"}],
                "tools":[{"type":"function","name":"exec","description":"original tool"}]
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("disabled stopless test expects JSON body");
    };
    assert_eq!(body["status"], "completed");
    let provider_body = transport.captures.lock().unwrap().first().unwrap().clone();
    let serialized = serde_json::to_string(&provider_body).unwrap();
    for forbidden in [
        "reasoningStop",
        "<rcc_stop_schema>",
        "call_stopless_reasoning",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "feature disabled must not inject relay stopless marker {forbidden}: {serialized}"
        );
    }
}
