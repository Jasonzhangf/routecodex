use serde_json::Value;

use super::super::features::RoutingFeatures;
use super::super::provider_registry::ProviderRegistry;
use super::config::default_pool_supports_capability;
use super::config::RoutingPools;

pub(crate) fn parse_direct_provider_model(
    model_value: Option<&Value>,
    registry: &ProviderRegistry,
) -> Option<(String, String)> {
    let raw = model_value.and_then(|v| v.as_str()).unwrap_or("").trim();
    if raw.is_empty() {
        return None;
    }
    let first_dot = raw.find('.')?;
    if first_dot == 0 || first_dot + 1 >= raw.len() {
        return None;
    }
    let provider_id = raw[..first_dot].trim();
    let model_id = raw[first_dot + 1..].trim();
    if provider_id.is_empty() || model_id.is_empty() {
        return None;
    }
    if registry.list_provider_keys(provider_id).is_empty() {
        return None;
    }
    Some((provider_id.to_string(), model_id.to_string()))
}

pub(crate) fn select_direct_provider_model(
    provider_id: &str,
    model_id: &str,
    registry: &ProviderRegistry,
    is_available: impl Fn(&str) -> bool,
) -> Option<String> {
    let keys = registry.list_provider_keys(provider_id);
    for key in keys {
        if let Some(profile) = registry.get(&key) {
            if profile.model_id.as_deref() == Some(model_id) && is_available(&key) {
                return Some(key);
            }
        }
    }
    None
}

pub(crate) fn should_fallback_direct_model_for_media(
    provider_id: &str,
    model_id: &str,
    features: &RoutingFeatures,
    routing: &RoutingPools,
    provider_registry: &ProviderRegistry,
) -> bool {
    if !features.has_image_attachment && !features.has_video_attachment {
        return false;
    }
    let needs_multimodal = features.has_image_attachment
        || (features.has_video_attachment && features.has_remote_video_attachment);
    if !needs_multimodal {
        return false;
    }
    if !default_pool_supports_capability(routing, provider_registry, "multimodal") {
        return false;
    }
    // Check if the target provider+model has multimodal capability.
    // If not, fallback to the default pool which may have multimodal-capable providers.
    let keys = provider_registry.list_provider_keys(provider_id);
    let has_multimodal = keys.iter().any(|key| {
        provider_registry
            .get(key)
            .and_then(|p| p.model_id.as_deref())
            == Some(model_id)
            && provider_registry.has_capability(key, "multimodal")
    });
    !has_multimodal
}
