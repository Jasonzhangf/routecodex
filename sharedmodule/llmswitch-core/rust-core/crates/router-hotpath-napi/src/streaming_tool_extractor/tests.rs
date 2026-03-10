use super::{
    create_streaming_tool_extractor_state_json, extract_streaming_tool_calls_json,
    feed_streaming_tool_extractor_json, reset_streaming_tool_extractor_state_json,
};
use serde_json::json;

#[test]
fn streaming_tool_extractor_exec_block() {
    let input = json!({
        "buffer": "",
        "text": "<function=execute><parameter=command>pwd</parameter></function=execute>",
        "idPrefix": "call",
        "idCounter": 0,
        "nowMs": 1700000000000i64
    })
    .to_string();
    let raw = extract_streaming_tool_calls_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let tool_calls = parsed["toolCalls"].as_array().unwrap();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["function"]["name"], "shell");
}

#[test]
fn streaming_tool_extractor_structured_apply_patch() {
    let payload = r#"```json
{"changes":[{"kind":"add","file":"a.txt","content":"hi"}]}
```"#;
    let input = json!({
        "buffer": "",
        "text": payload,
        "idPrefix": "call",
        "idCounter": 0,
        "nowMs": 1700000000000i64
    })
    .to_string();
    let raw = extract_streaming_tool_calls_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let tool_calls = parsed["toolCalls"].as_array().unwrap();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["function"]["name"], "apply_patch");
}

#[test]
fn streaming_tool_extractor_stateful_feed_and_reset() {
    let state_raw =
        create_streaming_tool_extractor_state_json(Some(json!({"idPrefix":"stream"}).to_string()))
            .unwrap();
    let input = json!({
        "state": serde_json::from_str::<serde_json::Value>(&state_raw).unwrap(),
        "text": "<function=execute><parameter=command>pwd</parameter></function=execute>",
        "nowMs": 1700000000001i64
    })
    .to_string();
    let raw = feed_streaming_tool_extractor_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["toolCalls"].as_array().unwrap().len(), 1);
    assert_eq!(parsed["toolCalls"][0]["function"]["name"], "shell");
    assert_eq!(parsed["state"]["idPrefix"], "stream");

    let reset_raw = reset_streaming_tool_extractor_state_json(parsed["state"].to_string()).unwrap();
    let reset: serde_json::Value = serde_json::from_str(&reset_raw).unwrap();
    assert_eq!(reset["buffer"], "");
    assert_eq!(reset["idCounter"], 0);
    assert_eq!(reset["idPrefix"], "stream");
}
