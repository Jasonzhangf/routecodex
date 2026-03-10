use super::deepseek_web::apply_deepseek_web_response_compat;
use super::gemini_cli::cache_antigravity_thought_signature_from_gemini_response;
use super::glm::apply_glm_response_compat;
use super::iflow::apply_iflow_response_compat;
use super::lmstudio::apply_lmstudio_response_compat;
use super::profile::{
    build_compat_result, is_claude_code_profile, is_deepseek_web_profile, is_gemini_cli_profile,
    is_gemini_profile, is_glm_profile, is_iflow_profile, is_lmstudio_profile, is_qwen_profile,
    is_responses_c4m_profile, is_responses_output2choices_profile, pick_compat_profile,
    provider_protocol_matches,
};
use super::qwen::apply_qwen_response_compat;
use super::responses::{
    convert_responses_output_to_choices, detect_responses_c4m_rate_limit,
    ensure_response_request_id_fallback,
};
use super::{CompatResult, ReqOutboundCompatInput};

pub fn run_resp_inbound_stage3_compat(
    input: ReqOutboundCompatInput,
) -> Result<CompatResult, String> {
    let profile = pick_compat_profile(&input);
    if let Some(profile_id) = profile.as_deref() {
        if is_responses_output2choices_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-responses",
            ) {
                let mut payload = input.payload;
                if let Some(root) = payload.as_object_mut() {
                    convert_responses_output_to_choices(root);
                    ensure_response_request_id_fallback(
                        root,
                        input.adapter_context.request_id.as_ref(),
                    );
                }
                return Ok(CompatResult {
                    payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_claude_code_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "anthropic-messages",
            ) {
                return Ok(CompatResult {
                    payload: input.payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_responses_c4m_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-responses",
            ) {
                let rate_limit_detected = detect_responses_c4m_rate_limit(&input.payload);
                return Ok(CompatResult {
                    payload: input.payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: if rate_limit_detected {
                        Some(true)
                    } else {
                        None
                    },
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_qwen_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_qwen_response_compat(input.payload),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_deepseek_web_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_deepseek_web_response_compat(
                        input.payload,
                        &input.adapter_context,
                    )?,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_gemini_cli_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "gemini-chat",
            ) {
                return Ok(CompatResult {
                    payload: cache_antigravity_thought_signature_from_gemini_response(
                        input.payload,
                        &input.adapter_context,
                    ),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_gemini_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "gemini-chat",
            ) {
                return Ok(CompatResult {
                    payload: cache_antigravity_thought_signature_from_gemini_response(
                        input.payload,
                        &input.adapter_context,
                    ),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_glm_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_glm_response_compat(input.payload),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_iflow_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_iflow_response_compat(
                        input.payload,
                        input.adapter_context.request_id.as_ref(),
                    ),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }

        if is_lmstudio_profile(profile_id) {
            return Ok(CompatResult {
                payload: apply_lmstudio_response_compat(
                    input.payload,
                    input.adapter_context.request_id.as_ref(),
                ),
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
                rate_limit_detected: None,
            });
        }
    }

    Ok(build_compat_result(input.payload, None))
}
