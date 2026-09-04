// Test module for the Req04 Anthropic-native Tool-Thinking schema contract.
use super::*;
use serde_json::json;

#[test]
fn req04_tool_thinking_guidance_uses_native_anthropic_tool_use_and_bans_text_wrappers() {
    let mut payload = json!({
        "model": "MiniMax-M3",
        "system": "client system",
        "messages": [{"role":"user","content":"Call a tool"}],
        "tools": [{"name":"probe_tool","input_schema":{"type":"object"}}]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject");
    assert_eq!(payload["system"], "client system");
    assert!(payload["tools"][0]["input_schema"]["properties"]["reason"].is_object());
    assert!(payload["tools"][0]["input_schema"]["properties"]["goal_alignment_confidence"].is_object());
    assert!(!payload.to_string().contains("model_id"));
    assert!(!payload.to_string().contains("RouteCodex"));
}
