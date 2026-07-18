use routecodex_v3_runtime::{
    build_v3_provider_resp_inbound_01_raw, compile_v3_hub_relay_response_hooks,
    V3HubContinuationCommit, V3HubContinuationOwnership, V3HubEntryProtocol, V3HubExecutionMode,
    V3HubInvocationSource, V3HubProviderWireProtocol, V3HubRelayResponseHookProfile,
    V3HubResponseTerminality, V3HubTransportIntent,
};
use serde_json::{json, Value};

fn relay_raw(payload: Value) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
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

#[test]
fn stopless_projects_cli_for_live_responses_object_missing_finish_reason_and_schema() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "object":"response",
            "id":"resp_live_missing_schema_no_finish_reason",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{
                    "type":"output_text",
                    "text":"我还没有完成，需要继续。"
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
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["status"], "requires_action");
    assert_eq!(payload["output"][0]["call_id"], "call_stopless_reasoning");
    assert_eq!(payload["output"][0]["name"], "exec_command");
    assert!(payload["output"][0]["arguments"]
        .as_str()
        .unwrap()
        .contains("--input-json '{}'"));
}

#[test]
fn stopless_projects_cli_for_live_responses_object_invalid_schema_without_finish_reason() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_raw(json!({
            "object":"response",
            "id":"resp_live_invalid_schema_no_finish_reason",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{
                    "type":"output_text",
                    "text":"{\"stopreason\":\"two\",\"current_goal\":123,\"next_step\":false}"
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
    assert_eq!(resp03.terminality(), V3HubResponseTerminality::NonTerminal);
    assert_eq!(resp03.tool_call_count(), 1);

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["status"], "requires_action");
    assert_eq!(payload["output"][0]["call_id"], "call_stopless_reasoning");
    assert_eq!(payload["output"][0]["name"], "exec_command");
    assert!(payload["output"][0]["arguments"]
        .as_str()
        .unwrap()
        .contains("routecodex hook run reasoningStop"));
}
