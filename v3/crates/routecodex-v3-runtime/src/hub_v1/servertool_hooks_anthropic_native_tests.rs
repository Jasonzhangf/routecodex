// Test module for the Req04 Anthropic-native Tool-Thinking guidance contract.
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
    let tool_guidance = payload["tools"][0]["description"]
        .as_str()
        .expect("tool description must be string");

    for provider_guidance in [guidance, tool_guidance] {
        assert!(provider_guidance.contains("Anthropic native"));
        assert!(provider_guidance.contains("tool_use"));
        assert!(provider_guidance.contains("普通文本段"));
        assert!(provider_guidance.contains("通用 JSON wrapper"));
        assert!(provider_guidance.contains("tool_use.input"));
        assert!(provider_guidance.contains("goal_alignment_confidence"));
        assert!(provider_guidance.contains("model_id"));
        assert!(provider_guidance.contains("必须同时填写"));
        assert!(!provider_guidance.contains("可选"));
        assert!(!provider_guidance.contains("如提供"));
        assert!(!provider_guidance.contains("Responses/Chat"));
        assert!(!provider_guidance.contains("\"arguments\""));
        assert!(!provider_guidance.contains("\"name\":\"pwd\""));
        assert!(!provider_guidance.contains("metadata.reason"));
    }
}
