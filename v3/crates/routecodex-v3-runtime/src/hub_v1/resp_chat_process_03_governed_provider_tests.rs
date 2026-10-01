use super::*;

#[test]
fn resp03_recursive_strips_all_ciphers_without_anthropic_source() {
    let mut payload = json!({
        "id": "resp_mixed_ciphers",
        "status": "completed",
        "output": [
            {
                "type": "reasoning",
                "id": "rs_rsn",
                "encrypted_content": "rsn_KEEP_MARKER",
                "summary": [{"type": "summary_text", "text": "rsn plain"}]
            },
            {
                "type": "reasoning",
                "id": "rs_gaaaa",
                "encrypted_content": "gAAAAABqdG2IiB8zk0noWkFn0EuwCPiNRjdGDTNeOEH",
                "summary": [{"type": "summary_text", "text": "gaaaa plain"}]
            },
            {
                "type": "reasoning",
                "id": "rs_sig",
                "encrypted_content": "sig-anthropic-signature",
                "summary": [{"type": "summary_text", "text": "signed thought"}]
            },
            {
                "type": "reasoning",
                "id": "rs_resp04",
                "encrypted_content": "resp04-signature",
                "summary": [{"type": "summary_text", "text": "resp04 plain"}]
            },
            {
                "type": "reasoning",
                "id": "rs_deepseek",
                "encrypted_content": "411bd3dd-47a6-49c0-8eef-6a826f349bf6-0",
                "summary": [{"type": "summary_text", "text": "deepseek plain"}]
            }
        ]
    });

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false, false);

    let output = payload["output"].as_array().unwrap();
    // rsn_ / gAAAA Codex 密文剥离，明文 summary 保留。
    assert!(
        !output[0].to_string().contains("encrypted_content"),
        "rsn_ 密文必须剥离: {}",
        output[0]
    );
    assert_eq!(output[0]["summary"][0]["text"], "rsn plain");
    assert!(
        !output[1].to_string().contains("encrypted_content"),
        "gAAAA Codex 密文必须剥离: {}",
        output[1]
    );
    assert_eq!(output[1]["summary"][0]["text"], "gaaaa plain");
    assert!(output[2].get("encrypted_content").is_none());
    assert_eq!(output[2]["summary"][0]["text"], "signed thought");
    assert!(output[3].get("encrypted_content").is_none());
    assert!(output[4].get("encrypted_content").is_none());
}

#[test]
fn resp03_anthropic_signature_survives_govern_path() {
    let payload = json!({
        "id": "msg_anthropic_sig",
        "type": "message",
        "role": "assistant",
        "content": [
            {"type": "text", "text": "signed thought"},
            {"type": "redacted_thinking", "data": "sig-anthropic-signature"}
        ],
        "stop_reason": "end_turn"
    });
    let resp01 = build_v3_provider_resp_inbound_01_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Anthropic,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).unwrap();
    let stripped = strip_v3_resp03_encrypted_reasoning_content(resp02, false, false);

    let payload = serde_json::to_string(&*stripped.previous.previous.payload.0).unwrap();
    assert!(
        payload.contains("sig-anthropic-signature"),
        "Anthropic thinking signature must survive: {payload}"
    );
    assert!(payload.contains("signed thought"));
}
