use super::*;

#[test]
fn unmapped_non_identifier_key_is_actually_removed_from_chat_wire() {
    // `json_path_child` renders keys that are not bare identifiers as
    // `$["key"]`. The stage-3 drop must still physically remove the field: a
    // recorded but not-removed field would be a silent non-drop on the wire.
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "x-vendor-flag": {"nested": true}
    });

    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("unrepresentable vendor key must drop, not fail the request");

    assert!(wire.get("x-vendor-flag").is_none(), "{wire}");
    assert_eq!(wire["model"], json!("gpt-test"), "{wire}");
}

#[test]
fn unmapped_nested_non_identifier_key_is_actually_removed_from_chat_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "a.b": {"c": 1}
    });

    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("dotted vendor key must drop, not fail the request");

    assert!(wire.get("a.b").is_none(), "{wire}");
}

#[test]
fn unmapped_key_with_bracket_is_actually_removed_from_chat_wire() {
    // JSON string escaping does not escape `]`, so this key is rendered as
    // `$["weird]key"]`. The remover must still delete it: otherwise the drop is
    // recorded while the field stays on the provider wire.
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "weird]key": {"nested": true}
    });

    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("bracketed vendor key must drop, not fail the request");

    assert!(wire.get("weird]key").is_none(), "{wire}");
    assert_eq!(wire["model"], json!("gpt-test"), "{wire}");
}

#[test]
fn responses_target_carries_drop_records_for_unrepresentable_keys() {
    // The Responses provider wire has no slot for a vendor key. The stage-3
    // carrier must RETURN the record so the request-scoped context can stamp
    // and persist it; a wrapper that swallows it leaves only a stderr line.
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "x-vendor-flag": true
    });

    let (wire, drops) =
        build_v3_openai_responses_standard_request_for_selected_target_with_drops(&payload, false)
            .expect("unrepresentable vendor key must drop, not fail the request");

    assert!(wire.get("x-vendor-flag").is_none(), "{wire}");
    let record = drops
        .iter()
        .find(|record| record.json_path == "$[\"x-vendor-flag\"]")
        .unwrap_or_else(|| panic!("expected a drop record for the vendor key, got {drops:?}"));
    assert_eq!(record.canonical_value, json!(true));
    assert_eq!(record.target_protocol, "responses");
}

#[test]
fn anthropic_target_carries_drop_records_for_unrepresentable_keys() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "x-vendor-flag": true
    });

    let (wire, drops) = build_v3_anthropic_provider_request_source_from_chat_canonical_with_drops(
        &payload,
    )
    .expect("unrepresentable vendor key must drop, not fail the request");

    assert!(wire.get("x-vendor-flag").is_none(), "{wire}");
    assert!(
        drops
            .iter()
            .any(|record| record.json_path == "$[\"x-vendor-flag\"]"),
        "expected a drop record for the vendor key, got {drops:?}"
    );
}

#[test]
fn unmapped_empty_string_key_is_actually_removed_from_chat_wire() {
    // An empty key must not render as the bare path `$.`, which the reader
    // rejects; otherwise the drop is recorded while the field stays on the wire.
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "": {"nested": true}
    });

    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("empty vendor key must drop, not fail the request");

    assert!(wire.get("").is_none(), "{wire}");
    assert_eq!(wire["model"], json!("gpt-test"), "{wire}");
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
