use routecodex_v3_runtime::{
    characterize_v3_gemini_client_input_to_hub_semantic,
    characterize_v3_gemini_hub_response_semantic_to_client_projection,
    characterize_v3_gemini_hub_semantic_to_provider_wire,
    characterize_v3_gemini_provider_raw_to_hub_response_semantic, V3GeminiCodecError,
    V3GeminiCodecStage, V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent,
};
use serde_json::json;

#[test]
fn request_preserves_contents_tools_and_function_response_pairs() {
    let request = json!({
        "model": "gemini-2.5-pro",
        "contents": [
            {"role": "user", "parts": [{"text": "lookup weather"}]},
            {"role": "model", "parts": [{"functionCall": {"name": "lookup", "args": {"city": "Tokyo"}}}]},
            {"role": "user", "parts": [{"functionResponse": {"name": "lookup", "response": {"forecast": "sunny"}}}]}
        ],
        "tools": [{"functionDeclarations": [{"name": "lookup", "parameters": {"type": "object"}}]}],
        "generationConfig": {"temperature": 0.2}
    });
    let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &request);
    assert_eq!(
        semantic.trace().stage,
        V3GeminiCodecStage::ClientInputToHubSemantic
    );
    let wire = characterize_v3_gemini_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
    assert_eq!(
        wire.trace().stage,
        V3GeminiCodecStage::HubSemanticToProviderWire
    );
}

#[test]
fn function_response_identity_pairing_is_not_normalization() {
    for request in [
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"","response":{"x":1}}}]}]}),
        json!({"contents":[{"role":"user","parts":[{"functionResponse":{"name":"orphan","response":{"x":1}}}]}]}),
    ] {
        let semantic = characterize_v3_gemini_client_input_to_hub_semantic(
            request.clone(),
            V3HubEntryProtocol::Gemini,
            V3HubTransportIntent::Json,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &request);
    }
}

#[test]
fn json_response_preserves_candidates_usage_finish_reason_and_function_calls() {
    let response = json!({
        "candidates": [{
            "index": 0,
            "finishReason": "STOP",
            "content": {
                "role": "model",
                "parts": [
                    {"text": "result"},
                    {"functionCall": {"name": "lookup", "args": {"city": "Tokyo"}}}
                ]
            },
            "safetyRatings": []
        }],
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 4, "totalTokenCount": 14}
    });
    let semantic = characterize_v3_gemini_provider_raw_to_hub_response_semantic(
        response.clone(),
        V3HubProviderWireProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &response);
    assert_eq!(
        semantic.trace().stage,
        V3GeminiCodecStage::ProviderRawToHubResponseSemantic
    );
    let projected =
        characterize_v3_gemini_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(projected.payload(), &response);
    assert_eq!(
        projected.trace().stage,
        V3GeminiCodecStage::HubResponseSemanticToClientProjection
    );
}

#[test]
fn sse_characterization_preserves_individual_candidate_events_without_materialization() {
    let events = [
        json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"hel"}]},"finishReason":null}]}),
        json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":8}}),
    ];
    for event in events {
        let semantic = characterize_v3_gemini_provider_raw_to_hub_response_semantic(
            event.clone(),
            V3HubProviderWireProtocol::Gemini,
            V3HubTransportIntent::Sse,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &event);
        let projected =
            characterize_v3_gemini_hub_response_semantic_to_client_projection(semantic).unwrap();
        assert_eq!(projected.payload(), &event);
    }
}

#[test]
fn provider_error_protocol_and_side_channel_fail_closed() {
    let error = json!({"error":{"code":400,"message":"bad request","status":"INVALID_ARGUMENT"}});
    let semantic = characterize_v3_gemini_provider_raw_to_hub_response_semantic(
        error.clone(),
        V3HubProviderWireProtocol::Gemini,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(
        characterize_v3_gemini_hub_response_semantic_to_client_projection(semantic)
            .unwrap()
            .payload(),
        &error
    );
    assert!(matches!(
        characterize_v3_gemini_provider_raw_to_hub_response_semantic(
            json!({"error":{"code":400,"status":"INVALID_ARGUMENT"}}),
            V3HubProviderWireProtocol::Gemini,
            V3HubTransportIntent::Json,
        ),
        Err(V3GeminiCodecError::MalformedProviderError)
    ));
    assert!(matches!(
        characterize_v3_gemini_provider_raw_to_hub_response_semantic(
            json!({"candidates":[]}),
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3GeminiCodecError::ProviderProtocolNotGemini)
    ));
    for leaked in [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
        "continuation_owner",
    ] {
        let mut payload = json!({"contents":[]});
        payload
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!(true));
        assert!(matches!(
            characterize_v3_gemini_client_input_to_hub_semantic(
                payload,
                V3HubEntryProtocol::Gemini,
                V3HubTransportIntent::Json
            ),
            Err(V3GeminiCodecError::SideChannelLeaked { .. })
        ));
    }
    assert!(matches!(
        characterize_v3_gemini_client_input_to_hub_semantic(
            json!({"contents":[]}),
            V3HubEntryProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3GeminiCodecError::EntryProtocolNotGemini)
    ));
}
