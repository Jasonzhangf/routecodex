use serde_json::Value;

use super::super::features::RoutingFeatures;
use super::super::provider_registry::ProviderRegistry;
use super::config::{filter_pools_by_capability, filter_pools_by_visual_capability, RoutingPools};

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
    let keys = provider_registry.list_provider_keys(provider_id);
    let requires_video_capability =
        features.has_video_attachment && features.has_remote_video_attachment;
    let has_required_media_capability = keys.iter().any(|key| {
        provider_registry
            .get(key)
            .and_then(|p| p.model_id.as_deref())
            == Some(model_id)
            && if requires_video_capability {
                provider_registry.has_capability(key, "multimodal")
            } else {
                provider_registry.has_capability(key, "multimodal")
                    || provider_registry.has_capability(key, "vision")
            }
    });
    if has_required_media_capability {
        return false;
    }
    if features.has_image_attachment && !requires_video_capability {
        return routing_has_visual_targets(routing, provider_registry);
    }
    routing_has_capability_targets(routing, provider_registry, "multimodal")
}

fn routing_has_visual_targets(
    routing: &RoutingPools,
    provider_registry: &ProviderRegistry,
) -> bool {
    for route in matching_route_keys(routing, "multimodal")
        .into_iter()
        .chain(matching_route_keys(routing, "vision"))
    {
        let pools = routing.get(&route);
        if !filter_pools_by_visual_capability(&pools, provider_registry).is_empty() {
            return true;
        }
    }
    false
}

fn routing_has_capability_targets(
    routing: &RoutingPools,
    provider_registry: &ProviderRegistry,
    capability: &str,
) -> bool {
    for route in matching_route_keys(routing, capability) {
        let pools = routing.get(&route);
        if !filter_pools_by_capability(&pools, provider_registry, capability).is_empty() {
            return true;
        }
    }
    false
}

fn matching_route_keys(routing: &RoutingPools, route: &str) -> Vec<String> {
    let suffix = format!(":{}", route);
    routing
        .keys()
        .filter(|key| key.as_str() == route || key.ends_with(&suffix))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::config::parse_routing;
    use super::*;
    use serde_json::{json, Map, Value};

    fn registry_with_text_and_vision_models() -> ProviderRegistry {
        let mut registry = ProviderRegistry::default();
        let providers = json!({
            "text.key1.text-model": {
                "providerKey": "text.key1.text-model",
                "providerType": "openai",
                "modelId": "text-model"
            },
            "media.key1.vision-model": {
                "providerKey": "media.key1.vision-model",
                "providerType": "openai",
                "modelId": "vision-model",
                "modelCapabilities": {
                    "vision-model": ["vision"]
                }
            },
            "media.key1.mm-model": {
                "providerKey": "media.key1.mm-model",
                "providerType": "openai",
                "modelId": "mm-model",
                "modelCapabilities": {
                    "mm-model": ["multimodal"]
                }
            }
        });
        registry.load(providers.as_object().unwrap());
        registry
    }

    #[test]
    fn image_direct_model_without_visual_capability_falls_back_to_vision_route() {
        let registry = registry_with_text_and_vision_models();
        let routing = parse_routing(&Map::from_iter([(
            "vision".to_string(),
            Value::Array(vec![json!({
                "id": "vision",
                "priority": 100,
                "targets": ["media.key1.vision-model"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_image_attachment: true,
            ..RoutingFeatures::default()
        };

        assert!(should_fallback_direct_model_for_media(
            "text",
            "text-model",
            &features,
            &routing,
            &registry
        ));
    }

    #[test]
    fn image_direct_model_with_vision_capability_remains_direct() {
        let registry = registry_with_text_and_vision_models();
        let routing = parse_routing(&Map::from_iter([(
            "vision".to_string(),
            Value::Array(vec![json!({
                "id": "vision",
                "priority": 100,
                "targets": ["media.key1.vision-model"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_image_attachment: true,
            ..RoutingFeatures::default()
        };

        assert!(!should_fallback_direct_model_for_media(
            "media",
            "vision-model",
            &features,
            &routing,
            &registry
        ));
    }

    #[test]
    fn remote_video_direct_model_requires_multimodal_not_vision() {
        let registry = registry_with_text_and_vision_models();
        let routing = parse_routing(&Map::from_iter([(
            "multimodal".to_string(),
            Value::Array(vec![json!({
                "id": "multimodal",
                "priority": 100,
                "targets": ["media.key1.mm-model"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_video_attachment: true,
            has_remote_video_attachment: true,
            ..RoutingFeatures::default()
        };

        assert!(should_fallback_direct_model_for_media(
            "media",
            "vision-model",
            &features,
            &routing,
            &registry
        ));
        assert!(!should_fallback_direct_model_for_media(
            "media", "mm-model", &features, &routing, &registry
        ));
    }
}
