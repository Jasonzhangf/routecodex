use serde_json::Value;

use super::{CompatResult, ReqOutboundCompatInput};

fn strip_top_level_provider_internal_fields(payload: Value) -> Value {
    let Some(mut root) = payload.as_object().cloned() else {
        return payload;
    };
    root.remove("semantics");
    root.remove("processed");
    root.remove("processingMetadata");
    Value::Object(root)
}

fn normalize_profile(profile: Option<&String>) -> Option<String> {
    if let Some(profile) = profile {
        let trimmed = profile.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_ascii_lowercase());
        }
    }
    None
}

pub(super) fn pick_compat_profile(input: &ReqOutboundCompatInput) -> Option<String> {
    normalize_profile(input.explicit_profile.as_ref())
        .or_else(|| normalize_profile(input.adapter_context.compatibility_profile.as_ref()))
}

pub(super) fn build_compat_result(payload: Value, profile: Option<String>) -> CompatResult {
    CompatResult {
        payload: strip_top_level_provider_internal_fields(payload),
        applied_profile: profile,
        native_applied: true,
        rate_limit_detected: None,
    }
}

fn profile_matches(profile: &str, expected: &str) -> bool {
    profile.trim().eq_ignore_ascii_case(expected)
}

pub(super) fn is_claude_code_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:claude-code")
        || profile_matches(profile, "anthropic:claude-code")
}

pub(super) fn is_responses_c4m_profile(profile: &str) -> bool {
    profile_matches(profile, "responses:c4m")
}

pub(super) fn is_responses_crs_profile(profile: &str) -> bool {
    profile_matches(profile, "responses:crs")
}

pub(super) fn is_responses_output2choices_profile(profile: &str) -> bool {
    profile_matches(profile, "responses:output2choices-test")
}

pub(super) fn is_lmstudio_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:lmstudio")
}

pub(super) fn is_deepseek_web_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:deepseek-web")
}

pub(super) fn is_qwen_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:qwen")
}

pub(super) fn is_qwenchat_web_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:qwenchat-web")
}

pub(super) fn is_gemini_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:gemini")
}

pub(super) fn is_glm_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:glm")
}

pub(super) fn has_request_stage(profile: &str) -> bool {
    !is_responses_output2choices_profile(profile)
}

pub(super) fn provider_protocol_matches(protocol: Option<&String>, expected: &str) -> bool {
    match protocol {
        Some(value) => value.trim().eq_ignore_ascii_case(expected),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_compat_result_strips_top_level_internal_fields() {
        let result = build_compat_result(
            json!({
                "model": "MiniMax-M3",
                "messages": [{"role": "user", "content": "semantics word stays"}],
                "semantics": {"tools": {"clientToolsRaw": [{"name": "mcp__node_repl"}]}},
                "processed": {"status": "success"},
                "processingMetadata": {"streaming": {"enabled": false}}
            }),
            None,
        );
        let root = result.payload.as_object().unwrap();
        assert!(!root.contains_key("semantics"));
        assert!(!root.contains_key("processed"));
        assert!(!root.contains_key("processingMetadata"));
        assert_eq!(root.get("model"), Some(&json!("MiniMax-M3")));
        assert_eq!(
            root["messages"][0]["content"],
            json!("semantics word stays")
        );
    }
}
