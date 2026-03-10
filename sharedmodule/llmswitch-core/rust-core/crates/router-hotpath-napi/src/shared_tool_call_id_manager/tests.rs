use super::{
    create_tool_call_id_transformer_json, enforce_tool_call_id_style_json,
    extract_tool_call_id_json, normalize_id_value_json, transform_tool_call_id_json,
};
use serde_json::json;

#[test]
fn shared_tool_call_id_manager_normalize_id_value_json() {
    let input = json!({"value": "  abc "}).to_string();
    let raw = normalize_id_value_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed, "abc");
}

#[test]
fn shared_tool_call_id_manager_extract_tool_call_id_json() {
    let input = json!({"obj": {"tool_call_id": "tool_1"}}).to_string();
    let raw = extract_tool_call_id_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed, "tool_1");
}

#[test]
fn shared_tool_call_id_manager_transform_fc_style() {
    let state_raw =
        create_tool_call_id_transformer_json(json!({"style": "fc"}).to_string()).unwrap();
    let state: serde_json::Value = serde_json::from_str(&state_raw).unwrap();
    let input = json!({"state": state, "id": ""}).to_string();
    let raw = transform_tool_call_id_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed["id"].as_str().unwrap().starts_with("fc_"));
}

#[test]
fn shared_tool_call_id_manager_enforce_tool_call_id_style_json() {
    let state_raw =
        create_tool_call_id_transformer_json(json!({"style": "fc"}).to_string()).unwrap();
    let state: serde_json::Value = serde_json::from_str(&state_raw).unwrap();
    let input = json!({
        "messages": [
            {"role": "assistant", "tool_calls": [{"id": "call_1"}]},
            {"role": "tool", "tool_call_id": "call_2"}
        ],
        "state": state
    })
    .to_string();
    let raw = enforce_tool_call_id_style_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed["messages"][0]["tool_calls"][0]["id"]
        .as_str()
        .unwrap()
        .starts_with("fc_"));
    assert!(parsed["messages"][1]["tool_call_id"]
        .as_str()
        .unwrap()
        .starts_with("fc_"));
}
