//! Provider-wire-scoped provider-compat helpers for GLM targets on the OpenAI Chat wire.
//!
//! A provider such as `nvidia` can host both GLM and non-GLM models, and paid
//! or unrelated GLM hosts can accept `prompt_cache_key` and `verbosity`. The
//! rule therefore keys on the selected wire model inside the known free GLM
//! Chat provider/interface scope and never overrides an explicit profile.

use serde_json::Value;

/// Affected free GLM Chat interfaces reject these OpenAI Chat fields.
/// The rule stays a mechanical field removal and never rejects the request.
pub(super) fn drop_glm_unsupported_chat_fields(
    payload: &mut Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) {
    if provider_protocol != crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat
        || selected.compatibility_profile.is_some()
        || !is_affected_glm_chat_wire_scope(selected)
        || !is_glm_model(selected)
    {
        return;
    }
    if let Some(root) = payload.as_object_mut() {
        root.remove("prompt_cache_key");
        root.remove("verbosity");
    }
}

// This is a provider wire scope: the rule targets the free GLM Chat interfaces
// that reject these fields. Paid or unrelated hosts and explicit profiles keep
// their declared semantics.
fn is_affected_glm_chat_wire_scope(selected: &routecodex_v3_target::V3TargetCandidate) -> bool {
    selected.provider_id.eq_ignore_ascii_case("xcreate-free")
        || (selected.provider_id.eq_ignore_ascii_case("xcreate")
            && selected.interface_id.eq_ignore_ascii_case("openai_free"))
        || selected.provider_id.eq_ignore_ascii_case("nvidia")
}

fn is_glm_model(selected: &routecodex_v3_target::V3TargetCandidate) -> bool {
    [selected.model_id.trim(), selected.wire_model.trim()]
        .iter()
        .any(|model| {
            model
                .rsplit('/')
                .next()
                .is_some_and(|name| name.to_ascii_lowercase().starts_with("glm"))
        })
}
