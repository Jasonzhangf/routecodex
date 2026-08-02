use super::*;

#[test]
fn codex_client_metadata_keeps_source_identity_in_chat_extension() {
    let turn_metadata = "x".repeat(577);
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": "hello",
        "client_metadata": {
            "session_id": "019fbd31-bb6e-7a43-bfb2-17a1e46ec23b",
            "x-codex-turn-metadata": turn_metadata
        }
    }))
    .expect("Codex client metadata is payload data");

    let extension = &request["routecodex_chat_extension"]["responses_request"];
    assert_eq!(
        extension["client_metadata"]["x-codex-turn-metadata"],
        "x".repeat(577)
    );
    assert!(extension.get("metadata").is_none());
}
