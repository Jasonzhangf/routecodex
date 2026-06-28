use super::glm::apply_glm_response_compat;
use super::lmstudio::apply_lmstudio_response_compat;
use super::profile::{
    build_compat_result, is_gemini_profile, is_glm_profile, is_lmstudio_profile,
    pick_compat_profile, provider_protocol_matches,
};
use super::{CompatResult, ReqOutboundCompatInput};

pub fn run_resp_inbound_stage3_compat(
    input: ReqOutboundCompatInput,
) -> Result<CompatResult, String> {
    let profile = pick_compat_profile(&input);
    if let Some(profile_id) = profile.as_deref() {
        if is_gemini_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "gemini-chat",
            ) {
                return Ok(CompatResult {
                    payload: input.payload,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
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
            });
        }
    }

    Ok(build_compat_result(input.payload, None))
}
