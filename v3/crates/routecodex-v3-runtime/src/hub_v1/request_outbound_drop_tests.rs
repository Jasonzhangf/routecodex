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
