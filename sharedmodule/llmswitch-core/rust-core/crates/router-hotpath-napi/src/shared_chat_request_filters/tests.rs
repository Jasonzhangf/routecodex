use super::prune_chat_request_payload_json;
use serde_json::json;

#[test]
fn shared_chat_request_filters_prune_payload() {
    let payload = json!({
        "__rcc_hidden": true,
        "metadata": {"x": 1},
        "originalStream": true,
        "_originalStreamOptions": {"a": 1},
        "stream": false,
        "messages": [
            {"role": "assistant", "tool_calls": [{"call_id": "c1", "tool_call_id": "t1", "function": {"name": "x"}}]},
            {"role": "tool", "call_id": "c2", "id": "legacy"}
        ]
    });
    let input = json!({"payload": payload, "preserveStreamField": false}).to_string();
    let raw = prune_chat_request_payload_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed.get("__rcc_hidden").is_none());
    assert!(parsed.get("metadata").is_none());
    assert!(parsed.get("stream").is_none());
    assert_eq!(parsed["messages"][0]["tool_calls"][0].get("call_id"), None);
    assert_eq!(
        parsed["messages"][0]["tool_calls"][0].get("tool_call_id"),
        None
    );
    assert_eq!(parsed["messages"][1]["tool_call_id"], "c2");
    assert!(parsed["messages"][1].get("id").is_none());
    assert!(parsed["messages"][1].get("call_id").is_none());
}
