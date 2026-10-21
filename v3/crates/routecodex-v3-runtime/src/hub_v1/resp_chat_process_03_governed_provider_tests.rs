use super::*;

#[test]
fn responses_resp03_accepts_incomplete_terminal_with_optional_or_opaque_details() {
    for reason in [
        "max_output_tokens",
        "content_filter",
        "internal_error",
        "provider_specific_reason",
    ] {
        let governance = build_v3_responses_resp03_protocol_governance(&json!({
            "status":"incomplete",
            "incomplete_details":{"reason":reason},
            "output":[]
        }))
        .expect("registered Responses incomplete reason must remain a terminal response");
        assert_eq!(
            governance.status_terminality,
            V3HubResponseTerminality::Terminal
        );
    }

    for payload in [
        json!({"status":"incomplete","output":[]}),
        json!({"status":"incomplete","incomplete_details":null,"output":[]}),
        json!({"status":"incomplete","incomplete_details":{"reason":""},"output":[]}),
        json!({"status":"incomplete","incomplete_details":{"reason":42},"output":[]}),
    ] {
        let governance = build_v3_responses_resp03_protocol_governance(&payload).unwrap();
        assert_eq!(
            governance.status_terminality,
            V3HubResponseTerminality::Terminal
        );
    }
}

#[test]
fn resp03_recursive_strips_all_non_tool_cipher_without_typed_anthropic_source() {
    // 响应安全边界不按密文形状判断来源。缺少 typed Anthropic source 时，
    // 所有 reasoning encrypted_content 都必须删除，业务工具输出除外。
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
                "id": "rs_uuid",
                "encrypted_content": "411bd3dd-47a6-49c0-8eef-6a826f349bf6-0",
                "summary": [{"type": "summary_text", "text": "uuid plain"}]
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "encrypted_content": "tool-output-business-value"
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
    assert!(
        output[2].get("encrypted_content").is_none(),
        "cipher shape must not infer an Anthropic source"
    );
    assert_eq!(output[2]["summary"][0]["text"], "signed thought");
    assert!(
        output[3].get("encrypted_content").is_none(),
        "UUID-shaped cipher must be stripped"
    );
    assert_eq!(output[3]["summary"][0]["text"], "uuid plain");
    assert_eq!(
        output[4]["encrypted_content"], "tool-output-business-value",
        "function_call_output is business data and must be preserved"
    );
}

#[test]
fn resp03_anthropic_source_witness_preserves_signature_after_canonical_projection() {
    // Relay SSE 会把 Anthropic payload materialize 成 canonical Responses；
    // source_provider_protocol 是唯一仍可证明原始 wire 来源的 typed witness。
    let payload = json!({
        "id": "resp_anthropic_sig",
        "status": "completed",
        "output": [{
            "type": "reasoning",
            "encrypted_content": "sig-anthropic-signature",
            "summary": [{"type": "summary_text", "text": "signed thought"}]
        }]
    });
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        payload,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Sse,
        )
        .with_source_provider_protocol(V3HubProviderWireProtocol::Anthropic),
    );
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).unwrap();
    let stripped = strip_v3_resp03_encrypted_reasoning_content(resp02, false);

    let payload = serde_json::to_string(&*stripped.previous.previous.payload.0).unwrap();
    assert!(
        payload.contains("sig-anthropic-signature"),
        "anthropic thinking signature 载体不得被剥离: {payload}"
    );
    assert!(payload.contains("signed thought"));
}
