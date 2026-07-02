use super::glm::apply_glm_response_compat;
use super::lmstudio::apply_lmstudio_response_compat;
use super::profile::{
    build_compat_result, is_gemini_profile, is_glm_profile, is_lmstudio_profile,
    is_minimax_profile, pick_compat_profile, provider_protocol_matches,
};
use super::{CompatResult, ReqOutboundCompatInput};
use crate::compat_harvest_tool_calls_from_text::harvest_tool_calls_from_text_json;
use serde_json::Value;

fn harvest_text_tool_calls(payload: Value) -> Result<Value, String> {
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("serialize response compat payload: {}", error))?;
    let normalized_json = harvest_tool_calls_from_text_json(payload_json, None)
        .map_err(|error| format!("harvest response text tool calls: {}", error))?;
    serde_json::from_str(&normalized_json)
        .map_err(|error| format!("parse harvested response compat payload: {}", error))
}

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

        if is_minimax_profile(profile_id) {
            if provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-responses",
            ) || provider_protocol_matches(
                input.adapter_context.provider_protocol.as_ref(),
                "openai-chat",
            ) {
                return Ok(CompatResult {
                    payload: harvest_text_tool_calls(input.payload)?,
                    applied_profile: Some(profile_id.to_string()),
                    native_applied: true,
                });
            }
            return Ok(build_compat_result(input.payload, None));
        }
    }

    Ok(build_compat_result(input.payload, None))
}
