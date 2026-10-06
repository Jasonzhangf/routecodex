use super::*;

#[test]
fn multimodal_target_preserves_image_bytes_for_session_semantics() {
    let mut payload = json!({
        "messages": [{"role": "user", "content": [{
            "type": "image_url",
            "image_url": {"url": VALID_1X1_PNG_DATA_URL}
        }]}]
    });
    project_v3_images_for_selected_target_session_compat(
        &mut payload,
        &[
            "text".to_string(),
            "multimodal".to_string(),
            "vision".to_string(),
        ],
    );
    assert_eq!(
        payload["messages"][0]["content"][0]["image_url"]["url"],
        VALID_1X1_PNG_DATA_URL
    );
}

#[test]
fn non_multimodal_target_projects_image_to_session_placeholder() {
    let mut payload = json!({
        "messages": [{"role": "user", "content": [{
            "type": "image_url",
            "image_url": {"url": VALID_1X1_PNG_DATA_URL}
        }]}]
    });
    project_v3_images_for_selected_target_session_compat(
        &mut payload,
        &["text".to_string(), "tools".to_string()],
    );
    assert_eq!(
        payload["messages"][0]["content"][0],
        json!({"type": "text", "text": "[Image]"})
    );
}

#[test]
fn openai_chat_deepseek_v41_consumes_responses_only_transport_options_before_provider_wire() {
    let req07 = relay_req07_for_entry_with_selected(
        V3HubEntryProtocol::Responses,
        json!({
            "model": "client-route-alias",
            "input": "hello",
            "parallel_tool_calls": true,
            "store": false,
            "stream_options": {"include_usage": true}
        }),
        V3HubProviderWireProtocol::OpenAiChat,
        |selected| {
            selected.compatibility_profile = Some("chat:openai".to_string());
            selected.model_id = "deepseek-v4.1-flash".to_string();
            selected.wire_model = "deepseek-v4.1-flash".to_string();
        },
    );

    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .expect("Responses transport options must not become DeepSeek wire fields");
    let payload = req_compat.provider_semantic_payload();
    assert!(payload.get("store").is_none(), "{payload}");
    assert!(payload.get("stream_options").is_none(), "{payload}");
    assert_eq!(payload["parallel_tool_calls"], true, "{payload}");
}

#[test]
fn openai_chat_deepseek_v41_preserves_standard_chat_parallel_tool_calls() {
    let req07 = relay_req07_for_entry_with_selected(
        V3HubEntryProtocol::OpenAiChat,
        json!({
            "model": "deepseek-v4.1-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "parallel_tool_calls": true
        }),
        V3HubProviderWireProtocol::OpenAiChat,
        |selected| {
            selected.compatibility_profile = Some("chat:openai".to_string());
            selected.model_id = "deepseek-v4.1-flash".to_string();
            selected.wire_model = "deepseek-v4.1-flash".to_string();
        },
    );

    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .expect("standard Chat tool policy must pass through provider compat unchanged");
    let payload = req_compat.provider_semantic_payload();
    assert_eq!(payload["parallel_tool_calls"], true, "{payload}");
}
