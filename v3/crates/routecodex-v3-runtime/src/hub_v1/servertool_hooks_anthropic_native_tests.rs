// Test module for V3_TOOL_THINKING_GUIDANCE Anthropic native contract.
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
    let guidance = payload["system"].as_str().expect("system must be string");

    assert!(guidance.contains("Anthropic native"));
    assert!(guidance.contains("tool_use"));
    assert!(guidance.contains("普通文本段"));
    assert!(guidance.contains("通用 JSON wrapper"));
    assert!(guidance.contains("tool_use.input"));
    assert!(!guidance.contains("metadata.reason"));
}
