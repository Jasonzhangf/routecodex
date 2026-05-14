use super::claude_code::apply_anthropic_claude_code_system_prompt_compat;
use super::deepseek_web::apply_deepseek_web_request_compat;
use super::gemini::apply_gemini_request_compat;
use super::glm::apply_glm_request_compat;
use super::iflow::apply_iflow_request_compat;
use super::lmstudio::apply_lmstudio_request_compat;
use super::profile::{
    build_compat_result, has_request_stage, is_claude_code_profile, is_deepseek_web_profile,
    is_gemini_profile, is_glm_profile, is_iflow_profile,
    is_lmstudio_profile, is_qwen_profile, is_qwenchat_web_profile, is_responses_c4m_profile,
    is_responses_crs_profile, pick_compat_profile, provider_protocol_matches,
};
use super::qwen::apply_qwen_request_compat;
use super::qwenchat::apply_qwenchat_request_compat;
use super::responses::{apply_responses_c4m_request_compat, apply_responses_crs_request_compat};
use super::thinking_history::{
    ensure_reasoning_content_for_anthropic_assistant_history,
    ensure_reasoning_content_for_assistant_history,
    should_apply_anthropic_thinking_history_compat,
    should_apply_local_deepseek_thinking_history_compat,
};
use super::{CompatResult, ReqOutboundCompatInput};

pub fn run_req_outbound_stage3_compat(
    input: ReqOutboundCompatInput,
) -> Result<CompatResult, String> {
    let profile = pick_compat_profile(&input);
    let ReqOutboundCompatInput {
        payload: input_payload,
        adapter_context,
        ..
    } = input;

    let mut payload = input_payload;
    if should_apply_local_deepseek_thinking_history_compat(&payload, &adapter_context) {
        if let Some(root) = payload.as_object_mut() {
            ensure_reasoning_content_for_assistant_history(root);
        }
    }
    if should_apply_anthropic_thinking_history_compat(&payload, &adapter_context) {
        if let Some(root) = payload.as_object_mut() {
            ensure_reasoning_content_for_anthropic_assistant_history(root);
        }
    }

    if let Some(profile_id) = profile.as_deref() {
        if is_claude_code_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "anthropic-messages",
            ) {
                if let Some(root) = payload.as_object_mut() {
                    apply_anthropic_claude_code_system_prompt_compat(root, &adapter_context);
                }
                return Ok(CompatResult {
                    payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_responses_c4m_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "openai-responses",
            ) {
                if let Some(root) = payload.as_object_mut() {
                    apply_responses_c4m_request_compat(root);
                }
                return Ok(CompatResult {
                    payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_responses_crs_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "openai-responses",
            ) {
                if let Some(root) = payload.as_object_mut() {
                    apply_responses_crs_request_compat(root);
                }
                return Ok(CompatResult {
                    payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_qwen_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                let payload = if let Some(root) = payload.as_object() {
                    apply_qwen_request_compat(root)
                } else {
                    payload
                };
                return Ok(CompatResult {
                    payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_lmstudio_profile(profile_id) {
            if let Some(root) = payload.as_object_mut() {
                apply_lmstudio_request_compat(root, &adapter_context);
            }
            return Ok(CompatResult {
                payload,
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
                rate_limit_detected: None,
            });
        }

        if is_iflow_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_iflow_request_compat(payload, &adapter_context),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_glm_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_glm_request_compat(payload),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_deepseek_web_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_deepseek_web_request_compat(payload, &adapter_context),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_qwenchat_web_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                let payload = if let Some(root) = payload.as_object() {
                    apply_qwenchat_request_compat(root)
                } else {
                    payload
                };
                return Ok(CompatResult {
                    payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }

        if is_gemini_profile(profile_id) {
            if provider_protocol_matches(
                adapter_context.provider_protocol.as_ref(),
                "gemini-chat",
            ) {
                return Ok(CompatResult {
                    payload: apply_gemini_request_compat(payload, &adapter_context),
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                    rate_limit_detected: None,
                });
            }
            return Ok(build_compat_result(payload, None));
        }


        if !has_request_stage(profile_id) {
            return Ok(build_compat_result(payload, None));
        }
    }

    Ok(build_compat_result(payload, None))
}
