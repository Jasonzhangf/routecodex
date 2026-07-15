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
    assert_eq!(wire.payload(), &client);
    assert_eq!(wire.payload()["messages"], client["messages"]);
    assert_eq!(wire.payload()["tools"], client["tools"]);
    assert_eq!(wire.payload()["thinking"], client["thinking"]);
    assert!(wire.payload().get("anthropic_version").is_none());
    assert_eq!(
        wire.trace().stage,
        V3AnthropicCodecStage::HubSemanticToProviderWire
    );
}

#[test]
fn response_characterization_preserves_anthropic_json_tool_use_reasoning_and_client_projection() {
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
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &raw);
    assert_eq!(
        semantic.trace().transport_intent,
        V3HubTransportIntent::Json
    );
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
fn sse_characterization_preserves_individual_reasoning_and_tool_events_without_materialization() {
    let events = [
        json!({
            "type":"content_block_start",
            "index":0,
            "content_block":{"type":"thinking","thinking":""}
        }),
        json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{"type":"thinking_delta","thinking":"trace"}
        }),
        json!({
            "type":"content_block_start",
            "index":1,
            "content_block":{"type":"tool_use","id":"toolu_sse","name":"lookup","input":{}}
        }),
        json!({
            "type":"content_block_delta",
            "index":1,
            "delta":{"type":"input_json_delta","partial_json":r#"{"q":"z"}"#}
        }),
        json!({"type":"message_stop"}),
    ];
    for event in events {
        let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            event.clone(),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Sse,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &event);
        assert_eq!(semantic.trace().transport_intent, V3HubTransportIntent::Sse);
        let client =
            characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
        assert_eq!(client.payload(), &event);
    }
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
    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            json!({"type":"invented_event"}),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Sse,
        ),
        Err(V3AnthropicCodecError::MalformedSseEvent)
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
