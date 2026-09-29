use super::*;

#[test]
fn openai_chat_deepseek_v41_consumes_responses_only_transport_options_before_provider_wire() {
    let mut req07 = relay_req07_for_entry(
        V3HubEntryProtocol::Responses,
        json!({
            "model": "client-route-alias",
            "input": "hello",
            "parallel_tool_calls": true,
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
    assert_eq!(payload["parallel_tool_calls"], true, "{payload}");
}

#[test]
fn openai_chat_deepseek_v41_preserves_standard_chat_parallel_tool_calls() {
    let mut req07 = relay_req07_for_entry(
        V3HubEntryProtocol::OpenAiChat,
        json!({
            "model": "deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "parallel_tool_calls": true
        }),
        V3HubProviderWireProtocol::OpenAiChat,
    );
    req07.previous.selected_target.compatibility_profile = Some("chat:openai".to_string());
    req07.previous.selected_target.model_id = "deepseek-v4.1-flash".to_string();
    req07.previous.selected_target.wire_model = "deepseek-v4.1-flash".to_string();

    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .expect("standard Chat tool policy must pass through provider compat unchanged");
    let payload = req_compat.provider_semantic_payload();
    assert_eq!(payload["parallel_tool_calls"], true, "{payload}");
}
