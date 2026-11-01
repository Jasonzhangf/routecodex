//! DeepSeek-family provider-compat helpers for stage 6.
//!
//! Split out of `provider_req_compat_06_provider_compat.rs` to keep that file
//! under the module line limit. Behaviour is unchanged.

use serde_json::Value;

pub(super) fn normalize_deepseek_tool_choice(
    payload: &mut Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) {
    let is_deepseek_target = matches!(
        selected.compatibility_profile.as_deref(),
        Some("chat:deepseek-max" | "responses:deepseek-console-go")
    ) || is_v3_deepseek_v4_compat_model(&selected.model_id)
        || is_v3_deepseek_v4_compat_model(&selected.wire_model);
    if matches!(
        provider_protocol,
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat
            | crate::hub_v1::V3HubProviderWireProtocol::Responses
    ) && is_deepseek_target
    {
        provider_compat_core::apply_deepseek_v4_request_compat(payload);
    }
}

pub(super) fn is_v3_deepseek_v4_compat_model(model_id: &str) -> bool {
    matches!(
        model_id.trim().to_ascii_lowercase().as_str(),
        "deepseek-v4-flash" | "deepseek-v4.1-flash"
    )
}
