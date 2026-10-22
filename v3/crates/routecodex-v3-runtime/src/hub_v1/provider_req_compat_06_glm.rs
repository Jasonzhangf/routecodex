//! Model-scoped provider-compat helpers for GLM targets on the OpenAI Chat wire.
//!
//! A provider such as `nvidia` can host both GLM and non-GLM models, so this
//! rule is keyed on the selected model instead of the provider id or profile.

use serde_json::Value;

/// GLM targets reject these OpenAI Chat fields on every hosting provider.
/// The rule stays a mechanical field removal and never rejects the request.
pub(super) fn drop_glm_unsupported_chat_fields(
    payload: &mut Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) {
    if provider_protocol != crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat
        || !is_glm_model(selected)
    {
        return;
    }
    if let Some(root) = payload.as_object_mut() {
        root.remove("prompt_cache_key");
        root.remove("verbosity");
    }
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
