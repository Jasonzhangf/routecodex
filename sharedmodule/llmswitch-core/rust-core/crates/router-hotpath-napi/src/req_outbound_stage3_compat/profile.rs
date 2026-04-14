use serde_json::Value;

use super::{CompatResult, ReqOutboundCompatInput};

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
        payload,
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

pub(super) fn is_qwen_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:qwen")
}

pub(super) fn is_lmstudio_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:lmstudio")
}

pub(super) fn is_iflow_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:iflow")
}

pub(super) fn is_deepseek_web_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:deepseek-web")
}

pub(super) fn is_qwenchat_web_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:qwenchat-web")
}

pub(super) fn is_gemini_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:gemini")
}

pub(super) fn is_gemini_cli_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:gemini-cli")
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
