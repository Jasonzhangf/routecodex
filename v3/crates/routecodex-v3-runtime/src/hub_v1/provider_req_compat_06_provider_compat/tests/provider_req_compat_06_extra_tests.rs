use super::*;

#[test]
fn openai_chat_deepseek_v41_consumes_responses_transport_options_before_provider_wire() {
    let mut req07 = relay_req07_for_entry(
        V3HubEntryProtocol::Responses,
        json!({
            "model": "client-route-alias",
            "input": "hello",
            "store": false,
            "stream_options": {"include_usage": true}
        }),
        V3HubProviderWireProtocol::OpenAiChat,
    );
    req07.previous.selected_target.compatibility_profile = Some("chat:openai".to_string());
    req07.previous.selected_target.model_id = "deepseek-v4.1-flash".to_string();
    req07.previous.selected_target.wire_model = "deepseek-v4.1-flash".to_string();

    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .expect("Responses transport options must not become DeepSeek wire fields");
    let payload = req_compat.provider_semantic_payload();
    assert!(payload.get("store").is_none(), "{payload}");
    assert!(payload.get("stream_options").is_none(), "{payload}");
}
