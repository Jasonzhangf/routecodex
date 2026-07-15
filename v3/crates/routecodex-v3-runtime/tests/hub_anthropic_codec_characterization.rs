use routecodex_v3_runtime::{
    characterize_v3_anthropic_client_input_to_hub_semantic,
    characterize_v3_anthropic_hub_response_semantic_to_client_projection,
    characterize_v3_anthropic_hub_semantic_to_provider_wire,
    characterize_v3_anthropic_provider_raw_to_hub_response_semantic, V3AnthropicCodecError,
    V3AnthropicCodecStage, V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent,
};
use serde_json::json;

#[test]
fn request_characterization_preserves_anthropic_json_tool_result_and_reasoning_shape() {
    let client = json!({
        "model": "claude-sonnet",
        "system": [{"type":"text","text":"be exact"}],
        "messages": [
            {"role":"user","content":[{"type":"text","text":"hi"}]},
            {"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}
        ],
        "tools": [{"name":"lookup","input_schema":{"type":"object"}}],
        "thinking": {"type":"enabled","budget_tokens":1024},
        "stream": false
    });
    let semantic = characterize_v3_anthropic_client_input_to_hub_semantic(
        client.clone(),
        V3HubEntryProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &client);
    assert_eq!(
        semantic.trace().stage,
        V3AnthropicCodecStage::ClientInputToHubSemantic
    );

    let wire = characterize_v3_anthropic_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload()["messages"], client["messages"]);
    assert_eq!(wire.payload()["tools"], client["tools"]);
    assert_eq!(wire.payload()["thinking"], client["thinking"]);
    assert_eq!(wire.payload()["anthropic_version"], "2023-06-01");
    assert_eq!(
        wire.trace().stage,
        V3AnthropicCodecStage::HubSemanticToProviderWire
    );
}

#[test]
fn response_characterization_preserves_anthropic_sse_tool_use_reasoning_and_client_projection() {
    let raw = json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "stop_reason": "tool_use",
        "content": [
            {"type":"thinking","thinking":"short trace"},
            {"type":"text","text":"calling tool"},
            {"type":"tool_use","id":"toolu_2","name":"lookup","input":{"q":"y"}}
        ]
    });
    let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
        raw.clone(),
        V3HubProviderWireProtocol::Anthropic,
        V3HubTransportIntent::Sse,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &raw);
    assert_eq!(semantic.trace().transport_intent, V3HubTransportIntent::Sse);
    assert_eq!(
        semantic.trace().stage,
        V3AnthropicCodecStage::ProviderRawToHubResponseSemantic
    );

    let client =
        characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(client.payload(), &raw);
    assert_eq!(
        client.trace().stage,
        V3AnthropicCodecStage::HubResponseSemanticToClientProjection
    );
}

#[test]
fn provider_error_characterization_is_explicit_and_protocol_bound() {
    let error = json!({
        "type": "error",
        "error": {"type": "invalid_request_error", "message": "bad tool result"}
    });
    let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
        error.clone(),
        V3HubProviderWireProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let client =
        characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(client.payload(), &error);

    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            json!({"error":{"type":"invalid_request_error"}}),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::MalformedProviderError)
    ));
    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            error,
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::ProviderProtocolNotAnthropic)
    ));
}

#[test]
fn side_channel_and_protocol_fields_cannot_enter_anthropic_payloads() {
    for leaked in [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
    ] {
        let mut payload = json!({"messages":[]});
        payload
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!({"leak":true}));
        assert!(matches!(
            characterize_v3_anthropic_client_input_to_hub_semantic(
                payload,
                V3HubEntryProtocol::Anthropic,
                V3HubTransportIntent::Json,
            ),
            Err(V3AnthropicCodecError::SideChannelLeaked { .. })
        ));
    }
    assert!(matches!(
        characterize_v3_anthropic_client_input_to_hub_semantic(
            json!({"messages":[]}),
            V3HubEntryProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::EntryProtocolNotAnthropic)
    ));
}
