use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    build_v3_provider_resp_inbound_01_raw,
    build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05,
    compile_v3_hub_relay_request_hooks, compile_v3_hub_relay_response_hooks,
    V3HubContinuationCommit, V3HubContinuationLookup, V3HubContinuationOwnership,
    V3HubContinuationScope, V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource,
    V3HubProviderWireProtocol, V3HubRelayRequestHookEvent, V3HubRelayResponseHookProfile,
    V3HubRequestSemanticProtocol, V3HubResponseNormalizedKind, V3HubServertoolRequestProfile,
    V3HubServertoolResponseAction, V3HubTransportIntent,
};
use serde_json::{json, Value};

fn scope() -> V3HubContinuationScope {
    V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        "server-copy-probe",
        "relay-copy-probe",
        "session-copy-probe",
    )
}

fn request_raw(payload: Value) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    build_v3_hub_req_inbound_01_client_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    )
}

fn response_raw(
    payload: Value,
    transport: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport,
    )
}

fn large_input(label: &str) -> Value {
    json!({
        "model": "client-alias",
        "input": (0..128).map(|index| json!({
            "role": "user",
            "content": format!("{label}-{index}-{}", "x".repeat(256))
        })).collect::<Vec<_>>(),
        "metadata": {"client_owned": true}
    })
}

#[test]
fn relay_json_moves_one_business_payload_through_req04() {
    let payload = large_input("json");
    let outcome = compile_v3_hub_relay_request_hooks()
        .run(
            request_raw(payload),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .expect("Relay JSON request probe");

    let observed = outcome.payload();
    assert_eq!(
        outcome.semantic_protocol(),
        V3HubRequestSemanticProtocol::Chat
    );
    assert_eq!(observed["model"], json!("client-alias"));
    assert_eq!(observed["metadata"], json!({"client_owned": true}));
    assert!(
        observed.get("input").is_none(),
        "ReqInbound02 must move Responses input into Chat canonical messages before Req04"
    );
    let messages = observed["messages"]
        .as_array()
        .expect("ReqInbound02 Chat canonical messages");
    assert_eq!(messages.len(), 128);
    for (index, message) in messages.iter().enumerate() {
        assert_eq!(message["role"], json!("user"));
        assert_eq!(
            message["content"],
            json!(format!("json-{index}-{}", "x".repeat(256)))
        );
    }
    assert_eq!(outcome.continuation(), V3HubContinuationOwnership::New);
}

#[test]
fn relay_sse_keeps_one_canonical_payload_without_materializing_stream() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(response_raw(
            json!({
                "id": "resp_sse_copy_probe",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_sse_copy_probe",
                    "name": "servertool.exec",
                    "arguments": "{}"
                }]
            }),
            V3HubTransportIntent::Sse,
        ))
        .expect("SSE normalization");
    assert_eq!(resp02.normalized_kind(), V3HubResponseNormalizedKind::Sse);

    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::new(["servertool.exec"]),
        )
        .expect("SSE response governance");
    let resp04 = hooks.commit(resp03).expect("SSE continuation commit");
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    assert_eq!(resp04.canonical_context_count(), 1);
    assert!(resp04.canonical_context_shares_finalized_payload());

    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    assert_eq!(resp06.transport_intent(), V3HubTransportIntent::Sse);
    assert_eq!(
        resp06.response_exit_node(),
        "V3ServerRespOutbound06ClientFrame"
    );
}

#[test]
fn local_context_is_retained_until_req04_outcome_release() {
    let lookup = V3HubContinuationLookup::new(Some("rcc_copy_probe"), scope()).with_local_context(
        "rcc_copy_probe",
        scope(),
        large_input("local-context"),
    );
    let outcome = compile_v3_hub_relay_request_hooks()
        .run(
            request_raw(json!({"input": []})),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .expect("local continuation restore");

    drop(lookup);
    assert!(outcome.restored_local_context());
    assert_eq!(
        outcome.local_context().unwrap()["input"][127]["role"],
        "user"
    );
    assert!(outcome
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04LocalContextRestored));

    // The governed outcome is the final owner in this probe; dropping it is the explicit release point.
    drop(outcome);
}

#[test]
fn servertool_roundtrip_uses_one_resp04_context_and_restores_before_req04_hook() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(response_raw(
            json!({
                "id": "resp_servertool_copy_probe",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_servertool_copy_probe",
                    "name": "servertool.exec",
                    "arguments": "{\"path\":\"/tmp/probe\"}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::new(["servertool.exec"]),
        )
        .unwrap();
    assert_eq!(
        resp03.servertool_action(),
        V3HubServertoolResponseAction::FollowupRequired
    );
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert_eq!(resp04.canonical_context_count(), 1);
    assert!(resp04.canonical_context_shares_finalized_payload());

    let lookup = V3HubContinuationLookup::new(Some("rcc_servertool_copy_probe"), scope())
        .with_local_context(
            "rcc_servertool_copy_probe",
            scope(),
            json!({
                "id": "resp_servertool_copy_probe",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_servertool_copy_probe",
                    "name": "servertool.exec",
                    "arguments": "{\"path\":\"/tmp/probe\"}"
                }]
            }),
        );
    let request = compile_v3_hub_relay_request_hooks()
        .run(
            request_raw(json!({
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_servertool_copy_probe",
                    "output": "ok"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
        )
        .unwrap();
    let restore = request
        .hook_events()
        .iter()
        .position(|event| *event == V3HubRelayRequestHookEvent::Req04LocalContextRestored)
        .unwrap();
    let servertool = request
        .hook_events()
        .iter()
        .position(|event| *event == V3HubRelayRequestHookEvent::Req04ServertoolGoverned)
        .unwrap();
    assert!(restore < servertool);
}
