// resp_chat_process_03_governed 密文治理测试,拆分自 resp_chat_process_03_governed.rs
// 以满足 verify:v3-file-size。语义不变:`use super::*` 与内联 mod tests 等价。

use super::*;

#[test]
fn resp03_recursive_strips_codex_ciphers_but_keeps_anthropic_signature() {
    // recursive 层按值前缀区分：Codex 密文（rsn_ / gAAAA 开头）丢弃（客户端
    // 透明无感知）；anthropic 链的 thinking signature 载体（redacted_thinking.data
    // / thinking.signature，值不是 rsn_/gAAAA 前缀）保留给客户端做签名校验。
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
            }
        ]
    });

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

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
    // anthropic thinking signature 载体必须保留（非 rsn_/gAAAA 前缀）。
    assert_eq!(
        output[2]["encrypted_content"], "sig-anthropic-signature",
        "anthropic thinking signature 载体不得被剥离"
    );
    assert_eq!(output[2]["summary"][0]["text"], "signed thought");
    assert_eq!(
        output[3]["encrypted_content"], "resp04-signature",
        "anthropic thinking signature 载体不得被剥离"
    );
}

#[test]
fn resp03_anthropic_signature_survives_govern_path() {
    // anthropic 链的 thinking signature（非 rsn_/gAAAA 前缀）在完整 govern
    // 路径（strip -> harvest -> repair）后仍保留，客户端可用它做签名校验。
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
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
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
