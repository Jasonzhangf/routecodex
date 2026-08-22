use routecodex_v3_runtime::{
    characterize_v3_openai_chat_client_input_to_hub_semantic,
    characterize_v3_openai_chat_hub_response_semantic_to_client_projection,
    characterize_v3_openai_chat_hub_semantic_to_provider_wire,
    characterize_v3_openai_chat_provider_raw_to_hub_response_semantic, V3HubEntryProtocol,
    V3HubProviderWireProtocol, V3HubTransportIntent, V3OpenAiChatCodecError,
    V3OpenAiChatCodecStage,
};
use serde_json::json;

#[test]
fn request_preserves_messages_multiple_tool_calls_and_matching_results() {
    let request = json!({
        "model":"gpt-chat",
        "messages":[
            {"role":"system","content":"be exact"},
            {"role":"developer","content":"use tools"},
            {"role":"user","content":"lookup both"},
            {"role":"assistant","content":null,"tool_calls":[
                {"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"a\"}"}},
                {"id":"call_2","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"b\"}"}}
            ]},
            {"role":"tool","tool_call_id":"call_1","content":"A"},
            {"role":"tool","tool_call_id":"call_2","content":"B"}
        ],
        "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],
        "stream":false
    });
    let semantic = characterize_v3_openai_chat_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &request);
    assert_eq!(
        semantic.trace().stage,
        V3OpenAiChatCodecStage::ClientInputToHubSemantic
    );
    let wire = characterize_v3_openai_chat_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
    assert_eq!(
        wire.trace().stage,
        V3OpenAiChatCodecStage::HubSemanticToProviderWire
    );
}

#[test]
fn request_tool_identity_pairing_is_not_normalization() {
    for request in [
        json!({"messages":[{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"x","arguments":"{}"}}]}]}),
        json!({"messages":[{"role":"assistant","tool_calls":[{"id":"dup","type":"function","function":{"name":"x","arguments":"{}"}},{"id":"dup","type":"function","function":{"name":"y","arguments":"{}"}}]}]}),
        json!({"messages":[{"role":"tool","tool_call_id":"orphan","content":"x"}]}),
    ] {
        let semantic = characterize_v3_openai_chat_client_input_to_hub_semantic(
            request.clone(),
            V3HubEntryProtocol::OpenAiChat,
            V3HubTransportIntent::Json,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &request);
    }
}

#[test]
fn response_tool_identity_pairing_is_not_inbound_normalization() {
    let response = json!({
        "id":"chatcmpl_dup","object":"chat.completion","model":"gpt-chat",
        "choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[
            {"id":"dup","type":"function","function":{"name":"lookup","arguments":"{}"}},
            {"id":"dup","type":"function","function":{"name":"lookup2","arguments":"{}"}}
        ]}}]
    });
    let semantic = characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
        response.clone(),
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &response);
}

#[test]
fn json_response_preserves_choices_usage_finish_reason_and_tool_calls() {
    let response = json!({
        "id":"chatcmpl_1","object":"chat.completion","model":"gpt-chat",
        "choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_r","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"z\"}"}}]}}],
        "usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}
    });
    let semantic = characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
        response.clone(),
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &response);
    assert_eq!(
        semantic.trace().stage,
        V3OpenAiChatCodecStage::ProviderRawToHubResponseSemantic
    );
    let projected =
        characterize_v3_openai_chat_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(projected.payload(), &response);
    assert_eq!(
        projected.trace().stage,
        V3OpenAiChatCodecStage::HubResponseSemanticToClientProjection
    );
}

#[test]
fn sse_characterization_preserves_individual_delta_events_without_materialization() {
    let events = [
        json!({"id":"chatcmpl_s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}),
        json!({"id":"chatcmpl_s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_s","type":"function","function":{"name":"lookup","arguments":"{\"q\":"}}]},"finish_reason":null}]}),
        json!({"id":"chatcmpl_s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]},"finish_reason":"tool_calls"}]}),
    ];
    for event in events {
        let semantic = characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
            event.clone(),
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubTransportIntent::Sse,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &event);
        let projected =
            characterize_v3_openai_chat_hub_response_semantic_to_client_projection(semantic)
                .unwrap();
        assert_eq!(projected.payload(), &event);
    }
}

#[test]
fn provider_error_protocol_and_side_channel_fail_closed() {
    let error =
        json!({"error":{"message":"bad request","type":"invalid_request_error","code":"bad"}});
    let semantic = characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
        error.clone(),
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(
        characterize_v3_openai_chat_hub_response_semantic_to_client_projection(semantic)
            .unwrap()
            .payload(),
        &error
    );
    assert!(matches!(
        characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
            json!({"error":{"type":"invalid_request_error"}}),
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubTransportIntent::Json,
        ),
        Err(V3OpenAiChatCodecError::MalformedProviderError)
    ));
    assert!(matches!(
        characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
            json!({"choices":[]}),
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3OpenAiChatCodecError::ProviderProtocolNotOpenAiChat)
    ));
    for leaked in [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
        "continuation_owner",
    ] {
        let mut payload = json!({"messages":[]});
        payload
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!(true));
        assert!(matches!(
            characterize_v3_openai_chat_client_input_to_hub_semantic(
                payload,
                V3HubEntryProtocol::OpenAiChat,
                V3HubTransportIntent::Json
            ),
            Err(V3OpenAiChatCodecError::SideChannelLeaked { .. })
        ));
    }
    assert!(matches!(
        characterize_v3_openai_chat_client_input_to_hub_semantic(
            json!({"messages":[]}),
            V3HubEntryProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3OpenAiChatCodecError::EntryProtocolNotOpenAiChat)
    ));
}
