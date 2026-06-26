use serde_json::Value;

use super::super::features::RoutingFeatures;
use super::super::provider_registry::ProviderRegistry;

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
    let canonical_model_id = registry.resolve_canonical_model_id(provider_id, model_id)?;
    let keys = registry.list_provider_keys(provider_id);
    for key in keys {
        if let Some(profile) = registry.get(&key) {
            if profile.model_id.as_deref() == Some(&canonical_model_id) && is_available(&key) {
                return Some(key);
            }
        }
    }
    None
}

pub(crate) fn direct_model_media_requirement_error(
    provider_id: &str,
    model_id: &str,
    features: &RoutingFeatures,
    provider_registry: &ProviderRegistry,
) -> Option<String> {
    if !features.has_image_attachment && !features.has_video_attachment {
        return None;
    }
    let canonical_model_id = provider_registry.resolve_canonical_model_id(provider_id, model_id)?;
    let needs_multimodal = features.has_image_attachment
        || (features.has_video_attachment && features.has_remote_video_attachment);
    if !needs_multimodal {
        return None;
    }
    let keys = provider_registry.list_provider_keys(provider_id);
    let requires_video_capability =
        features.has_video_attachment && features.has_remote_video_attachment;
    let has_required_media_capability = keys.iter().any(|key| {
        provider_registry
            .get(key)
            .and_then(|p| p.model_id.as_deref())
            == Some(canonical_model_id.as_str())
            && if requires_video_capability {
                provider_registry.has_capability(key, "multimodal")
            } else {
                provider_registry.has_capability(key, "multimodal")
                    || provider_registry.has_capability(key, "vision")
            }
    });
    if has_required_media_capability {
        return None;
    }
    let requirement = if requires_video_capability {
        "multimodal"
    } else {
        "vision or multimodal"
    };
    Some(format!(
        "Direct model {}.{} cannot satisfy media requirement {}; explicit provider.model routing must not change route",
        provider_id, canonical_model_id, requirement
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn image_direct_model_without_visual_capability_fails_fast() {
        let registry = registry_with_text_and_vision_models();
        let features = RoutingFeatures {
            has_image_attachment: true,
            ..RoutingFeatures::default()
        };

        let error =
            direct_model_media_requirement_error("text", "text-model", &features, &registry)
                .expect("direct media requirement error");
        assert!(error.contains("Direct model text.text-model cannot satisfy media requirement"));
    }

    #[test]
    fn image_direct_model_with_vision_capability_remains_direct() {
        let registry = registry_with_text_and_vision_models();
        let features = RoutingFeatures {
            has_image_attachment: true,
            ..RoutingFeatures::default()
        };

        assert!(direct_model_media_requirement_error(
            "media",
            "vision-model",
            &features,
            &registry,
        )
        .is_none());
    }

    #[test]
    fn remote_video_direct_model_requires_multimodal_not_vision() {
        let registry = registry_with_text_and_vision_models();
        let features = RoutingFeatures {
            has_video_attachment: true,
            has_remote_video_attachment: true,
            ..RoutingFeatures::default()
        };

        let error =
            direct_model_media_requirement_error("media", "vision-model", &features, &registry)
                .expect("remote video requires multimodal");
        assert!(error.contains("media requirement multimodal"));
        assert!(
            direct_model_media_requirement_error("media", "mm-model", &features, &registry)
                .is_none()
        );
    }

    #[test]
    fn direct_model_alias_resolves_to_canonical_model_id() {
        let mut registry = ProviderRegistry::default();
        let providers = json!({
            "DF.key1.DeepSeek-V4-Pro": {
                "providerKey": "DF.key1.DeepSeek-V4-Pro",
                "providerType": "openai",
                "modelId": "DeepSeek-V4-Pro",
                "aliasToModel": {
                    "deepseek-v4-pro": "DeepSeek-V4-Pro"
                }
            }
        });
        registry.load(providers.as_object().unwrap());

        let selected = select_direct_provider_model("DF", "deepseek-v4-pro", &registry, |_| true);
        assert_eq!(selected, Some("DF.key1.DeepSeek-V4-Pro".to_string()));
    }
}
