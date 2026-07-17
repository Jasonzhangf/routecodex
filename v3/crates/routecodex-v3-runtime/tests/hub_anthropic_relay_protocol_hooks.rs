use routecodex_v3_runtime::{
    build_provider_resp_compat_02_from_v3_provider_resp_inbound_01,
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02,
    build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03,
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02,
    build_v3_provider_resp_inbound_01_raw, compile_v3_anthropic_relay_protocol_hooks,
    V3AnthropicRelayProtocolHookError, V3HubContinuationCommit, V3HubContinuationOwnership,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRespContinuation04Committed, V3HubTransportIntent,
};
use serde_json::json;

fn anthropic_request() -> serde_json::Value {
    json!({
        "model": "client-visible-claude",
        "system": [{"type":"text","text":"be exact"}],
        "messages": [
            {"role":"user","content":[{"type":"text","text":"hello"}]},
            {"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}
        ],
        "thinking": {"type":"enabled","budget_tokens":1024}
    })
}

fn response04(
    payload: serde_json::Value,
    entry_protocol: V3HubEntryProtocol,
    execution: V3HubExecutionMode,
    provider_wire_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> V3HubRespContinuation04Committed {
    let raw = build_v3_provider_resp_inbound_01_raw(
        payload,
        entry_protocol,
        provider_wire_protocol,
        V3HubContinuationOwnership::New,
        execution,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(raw);
    let normalized = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat);
    let governed = build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(normalized);
    build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
        governed,
        V3HubContinuationCommit::None,
    )
}

#[test]
fn anthropic_entry_req_inbound_hook_is_static_relay_and_keeps_responses_wire_independent() {
    let hooks = compile_v3_anthropic_relay_protocol_hooks();
    let payload = anthropic_request();
    let raw = build_v3_hub_req_inbound_01_client_raw(
        payload.clone(),
        V3HubEntryProtocol::Anthropic,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );

    let normalized = hooks
        .req_inbound(
            raw,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Responses,
        )
        .expect("Anthropic Relay req_inbound hook");

    assert_eq!(normalized.payload(), &payload);
    assert_eq!(normalized.entry_protocol(), V3HubEntryProtocol::Anthropic);
    assert_eq!(normalized.node_id(), "V3HubReqInbound02Normalized");
}

#[test]
fn anthropic_client_projection_hook_preserves_responses_wire_axis() {
    let hooks = compile_v3_anthropic_relay_protocol_hooks();
    let hub_response = json!({
        "id": "msg_from_hub",
        "type": "message",
        "role": "assistant",
        "stop_reason": "tool_use",
        "content": [
            {"type":"thinking","thinking":"trace"},
            {"type":"text","text":"calling"},
            {"type":"tool_use","id":"toolu_2","name":"lookup","input":{"q":"y"}}
        ]
    });

    let projection = hooks
        .client_projection(response04(
            hub_response.clone(),
            V3HubEntryProtocol::Anthropic,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Json,
        ))
        .expect("Anthropic client projection hook");

    assert_eq!(projection.payload(), &hub_response);
    assert_eq!(projection.entry_protocol(), V3HubEntryProtocol::Anthropic);
    assert_eq!(projection.execution_mode(), V3HubExecutionMode::Relay);
    assert_eq!(
        projection.provider_wire_protocol(),
        V3HubProviderWireProtocol::Responses
    );
    assert_eq!(projection.node_id(), "V3HubRespOutbound05ClientSemantic");

    let sse_event = json!({
        "type":"content_block_delta",
        "index":0,
        "delta":{"type":"text_delta","text":"streamed"}
    });
    let sse_projection = hooks
        .client_projection(response04(
            sse_event.clone(),
            V3HubEntryProtocol::Anthropic,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Sse,
        ))
        .expect("Anthropic SSE client projection hook");
    assert_eq!(sse_projection.payload(), &sse_event);
    assert_eq!(sse_projection.transport_intent(), V3HubTransportIntent::Sse);
    assert_eq!(
        sse_projection.provider_wire_protocol(),
        V3HubProviderWireProtocol::Responses
    );
}

#[test]
fn wrong_entry_execution_and_provider_wire_combinations_fail_explicitly() {
    let hooks = compile_v3_anthropic_relay_protocol_hooks();
    for (entry, execution, provider, expected) in [
        (
            V3HubEntryProtocol::Responses,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Responses,
            V3AnthropicRelayProtocolHookError::EntryProtocolNotAnthropic,
        ),
        (
            V3HubEntryProtocol::Anthropic,
            V3HubExecutionMode::Direct,
            V3HubProviderWireProtocol::Responses,
            V3AnthropicRelayProtocolHookError::ExecutionModeNotRelay,
        ),
        (
            V3HubEntryProtocol::Anthropic,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Anthropic,
            V3AnthropicRelayProtocolHookError::ProviderWireProtocolNotResponses,
        ),
    ] {
        let raw = build_v3_hub_req_inbound_01_client_raw(
            anthropic_request(),
            entry,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        assert_eq!(
            hooks.req_inbound(raw, execution, provider).unwrap_err(),
            expected
        );
        assert_eq!(
            hooks
                .client_projection(response04(
                    json!({"type":"message","content":[]}),
                    entry,
                    execution,
                    provider,
                    V3HubTransportIntent::Json,
                ))
                .unwrap_err(),
            expected
        );
    }
}

#[test]
fn side_channel_fields_fail_at_both_protocol_hook_boundaries() {
    let hooks = compile_v3_anthropic_relay_protocol_hooks();
    for leaked in [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
    ] {
        let mut request = anthropic_request();
        request
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!({"leak":true}));
        let raw = build_v3_hub_req_inbound_01_client_raw(
            request,
            V3HubEntryProtocol::Anthropic,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        assert!(matches!(
            hooks.req_inbound(
                raw,
                V3HubExecutionMode::Relay,
                V3HubProviderWireProtocol::Responses,
            ),
            Err(V3AnthropicRelayProtocolHookError::Codec(_))
        ));

        let mut response = json!({"type":"message","content":[]});
        response
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!({"leak":true}));
        assert!(matches!(
            hooks.client_projection(response04(
                response,
                V3HubEntryProtocol::Anthropic,
                V3HubExecutionMode::Relay,
                V3HubProviderWireProtocol::Responses,
                V3HubTransportIntent::Json,
            )),
            Err(V3AnthropicRelayProtocolHookError::Codec(_))
        ));
    }
}
