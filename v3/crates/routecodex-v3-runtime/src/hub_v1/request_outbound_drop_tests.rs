use super::*;

#[test]
fn bug03df769_unmapped_business_keys_are_preserved_without_drop_records() {
    for key in [
        "x-vendor-flag",
        "a.b",
        "weird]key",
        "",
        "metadata_center",
        "requiredCapabilities",
    ] {
        let payload = json!({
            "model": "gpt-test",
            "messages": [{"role": "user", "content": "hello"}],
            key: {"nested": true}
        });
        for protocol in [
            V3OutboundTargetProtocol::OpenAiChat,
            V3OutboundTargetProtocol::OpenAiResponses,
            V3OutboundTargetProtocol::Anthropic,
            V3OutboundTargetProtocol::Gemini,
        ] {
            let (wire, drops) =
                project_outbound_payload_for_target_protocol_with_drops(&payload, protocol)
                    .expect("unknown JSON fields have an opaque representation");
            assert_eq!(wire.get(key), payload.get(key), "{protocol:?}: {key}");
            assert!(drops.is_empty(), "{protocol:?}: {drops:?}");
        }
    }
}

#[test]
fn empty_string_key_path_is_readable_and_removable() {
    assert_eq!(
        split_v3_json_path("$[\"\"]"),
        Some(vec![V3JsonPathSegment::Key(String::new())])
    );
    let mut value = json!({"": 1, "keep": 2});
    remove_unmapped_outbound_field(&mut value, "$[\"\"]");
    assert_eq!(value, json!({"keep": 2}));
}
