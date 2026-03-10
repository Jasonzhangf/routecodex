use super::{
    filter_invalid_thinking_blocks_json, has_valid_thought_signature_json,
    remove_trailing_unsigned_thinking_blocks_json, sanitize_thinking_block_json,
};
use serde_json::json;

#[test]
fn thought_signature_validator_has_valid_signature_true() {
    let input = json!({
        "block": {
            "type": "thinking",
            "thinking": "test",
            "thoughtSignature": "A".repeat(60)
        },
        "options": { "minLength": 50 }
    })
    .to_string();
    let raw = has_valid_thought_signature_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed, true);
}

#[test]
fn thought_signature_validator_sanitize_block_preserves_signature() {
    let input = json!({
        "block": {
            "type": "thinking",
            "thinking": "  hello ",
            "thoughtSignature": "sig"
        }
    })
    .to_string();
    let raw = sanitize_thinking_block_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["type"], "thinking");
    assert_eq!(parsed["thoughtSignature"], "sig");
    assert_eq!(parsed["thinking"], "hello");
}

#[test]
fn thought_signature_validator_filter_invalid_blocks() {
    let input = json!({
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": "hi",
                        "thoughtSignature": "short"
                    }
                ]
            }
        ],
        "options": { "minLength": 50, "convertToTextOnFailure": true }
    })
    .to_string();
    let raw = filter_invalid_thinking_blocks_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let content = &parsed[0]["content"];
    assert_eq!(content.as_array().unwrap().len(), 1);
    assert_eq!(content[0]["type"], "text");
}

#[test]
fn thought_signature_validator_remove_trailing_unsigned() {
    let input = json!({
        "blocks": [
            { "type": "text", "text": "hello" },
            { "type": "thinking", "thinking": "oops", "thoughtSignature": "short" }
        ],
        "options": { "minLength": 50 }
    })
    .to_string();
    let raw = remove_trailing_unsigned_thinking_blocks_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 1);
    assert_eq!(parsed[0]["type"], "text");
}
