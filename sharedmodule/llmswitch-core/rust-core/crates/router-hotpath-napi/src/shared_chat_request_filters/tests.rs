use super::{prune_chat_request_payload_json, prune_chat_request_payload_owned};
use serde_json::json;

#[test]
fn shared_chat_request_filters_prune_payload_json_wrapper() {
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

#[test]
fn shared_chat_request_filters_owned_path_preserves_protocol_fields() {
    let payload = json!({
        "model": "gpt-test",
        "__rcc_internal": true,
        "metadata": {"drop": true},
        "originalStream": true,
        "_originalStreamOptions": {"include_usage": true},
        "stream": false,
        "messages": [
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "call_wire",
                        "call_id": "call_internal",
                        "tool_call_id": "call_legacy",
                        "type": "function",
                        "function": {"name": "large_tool", "arguments": "{\"value\":\"x\"}"}
                    },
                    "non-object-call"
                ]
            },
            {"role": "tool", "call_id": "call_wire", "id": "legacy_result_id", "content": "result"}
        ],
        "extension": {"nested": ["kept", {"exactly": true}]}
    });

    let pruned = prune_chat_request_payload_owned(payload, false);

    assert!(pruned.get("__rcc_internal").is_none());
    assert!(pruned.get("metadata").is_none());
    assert!(pruned.get("originalStream").is_none());
    assert!(pruned.get("_originalStreamOptions").is_none());
    assert!(pruned.get("stream").is_none());
    assert_eq!(
        pruned["messages"][0]["tool_calls"][0],
        json!({
            "id": "call_wire",
            "type": "function",
            "function": {"name": "large_tool", "arguments": "{\"value\":\"x\"}"}
        })
    );
    assert_eq!(pruned["messages"][0]["tool_calls"][1], "non-object-call");
    assert_eq!(
        pruned["messages"][1],
        json!({"role": "tool", "tool_call_id": "call_wire", "content": "result"})
    );
    assert_eq!(
        pruned["extension"],
        json!({"nested": ["kept", {"exactly": true}]})
    );
}

#[test]
fn shared_chat_request_filters_owned_path_preserves_stream_when_requested() {
    let pruned = prune_chat_request_payload_owned(json!({"stream": false}), true);

    assert_eq!(pruned, json!({"stream": false}));
}

#[test]
fn shared_chat_request_filters_owned_path_keeps_non_object_payloads() {
    let payload = json!(["keep", {"nested": true}]);
    let pruned = prune_chat_request_payload_owned(payload.clone(), false);

    assert_eq!(pruned, payload);
}
