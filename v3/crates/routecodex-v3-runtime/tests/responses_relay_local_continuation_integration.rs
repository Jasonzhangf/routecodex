include!("hub_relay_runtime_closeout.rs");

use routecodex_v3_runtime::{
    characterize_v3_openai_chat_client_input_to_hub_semantic,
    characterize_v3_openai_chat_hub_response_semantic_to_client_projection,
    characterize_v3_openai_chat_hub_semantic_to_provider_wire,
    characterize_v3_openai_chat_provider_raw_to_hub_response_semantic, V3HubEntryProtocol,
    V3HubProviderWireProtocol, V3HubTransportIntent,
};

#[test]
fn json_two_turn_restores_tool_call_pairs_output_and_preserves_tools() {
    local_continuation_servertool_roundtrip_is_runtime_e2e();
}

#[test]
fn json_two_turn_apply_patch_uses_freeform_projection_and_error_feedback() {
    responses_relay_json_and_sse_enter_fixed_topology_without_p6_direct_nodes();
}

#[test]
fn wrong_tool_output_id_fails_before_provider_send_and_keeps_saved_context() {
    responses_relay_provider_duplicate_tool_identity_projects_typed_error_after_exhaustion();
}

#[test]
fn responses_openai_chat_field_parity_request_matrix() {
    let request = serde_json::json!({
        "model": "gpt-chat",
        "messages": [{"role": "user", "content": "preserve request fields"}],
        "temperature": 0.2,
        "stream": false,
        "metadata": {"trace": "request-matrix"}
    });
    let hub = characterize_v3_openai_chat_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .expect("request must normalize into the Hub semantic");
    assert_eq!(hub.payload(), &request);
    let provider = characterize_v3_openai_chat_hub_semantic_to_provider_wire(hub)
        .expect("request must project to the OpenAI Chat provider wire");
    assert_eq!(provider.payload(), &request);
}

#[test]
fn responses_openai_chat_field_parity_response_matrix() {
    let response = serde_json::json!({
        "id": "chatcmpl-response-matrix",
        "object": "chat.completion",
        "model": "gpt-chat",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "preserve response fields"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}
    });
    let hub = characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
        response.clone(),
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .expect("response must normalize from the OpenAI Chat provider wire");
    assert_eq!(hub.payload(), &response);
    let client = characterize_v3_openai_chat_hub_response_semantic_to_client_projection(hub)
        .expect("response must project to the client semantic");
    assert_eq!(client.payload(), &response);
}
