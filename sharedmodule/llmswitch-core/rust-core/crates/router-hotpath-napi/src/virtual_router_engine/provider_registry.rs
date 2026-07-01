use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};

use crate::virtual_router_engine::profile_utils::{normalize_capability_list, read_context_tokens};

#[derive(Debug, Clone)]
pub(crate) struct ProviderProfile {
    pub provider_key: String,
    pub provider_type: String,
    pub provider_protocol: String,
    pub enabled: bool,
    pub outbound_profile: Option<String>,
    pub compatibility_profile: Option<String>,
    pub runtime_key: Option<String>,
    pub model_id: Option<String>,
    pub model_capabilities: Option<HashMap<String, Vec<String>>>,
    pub process_mode: Option<String>,
    pub responses_config: Option<Value>,
    pub streaming: Option<Value>,
    pub max_context_tokens: Option<i64>,
    pub server_tools_disabled: bool,
    pub series: Option<String>,
    pub alias_to_model: Option<BTreeMap<String, String>>,
    pub provider_specific_config: HashMap<String, Value>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct ProviderRegistry {
    providers: HashMap<String, ProviderProfile>,
}

impl ProviderRegistry {
    pub(crate) fn load(&mut self, profiles: &Map<String, Value>) {
        self.providers.clear();
        for (key, value) in profiles.iter() {
            if let Some(profile) = Self::normalize_profile(key, value) {
                self.providers.insert(profile.provider_key.clone(), profile);
            }
        }
    }

    pub(crate) fn get(&self, provider_key: &str) -> Option<&ProviderProfile> {
        self.providers.get(provider_key)
    }

    pub(crate) fn list_keys(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    pub(crate) fn list_provider_keys(&self, provider_id: &str) -> Vec<String> {
        let prefix = format!("{}.", provider_id);
        self.list_keys()
            .into_iter()
            .filter(|key| key.starts_with(&prefix))
            .collect()
    }

    pub(crate) fn has_capability(&self, provider_key: &str, capability: &str) -> bool {
        let Some(profile) = self.providers.get(provider_key) else {
            return false;
        };
        let model_id = profile
            .model_id
            .clone()
            .unwrap_or_else(|| derive_model_id(&profile.provider_key));
        if model_id.is_empty() {
            return false;
        }
        profile
            .model_capabilities
            .as_ref()
            .and_then(|model_capabilities| model_capabilities.get(&model_id))
            .map(|capabilities| capabilities.iter().any(|item| item == capability))
            .unwrap_or(false)
    }

    pub(crate) fn resolve_runtime_key_by_index(
        &self,
        provider_id: &str,
        key_index: i64,
    ) -> Option<String> {
        let index = key_index - 1;
        if index < 0 {
            return None;
        }
        let keys = self.list_provider_keys(provider_id);
        keys.get(index as usize).cloned()
    }

    pub(crate) fn resolve_runtime_key_by_model(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Option<String> {
        let canonical_model_id = self.resolve_canonical_model_id(provider_id, model_id)?;
        for key in self.list_provider_keys(provider_id) {
            if let Some(profile) = self.providers.get(&key) {
                let candidate = profile
                    .model_id
                    .clone()
                    .unwrap_or_else(|| derive_model_id(&profile.provider_key));
                if candidate == canonical_model_id {
                    return Some(key);
                }
            }
        }
        None
    }

    pub(crate) fn resolve_canonical_model_id(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Option<String> {
        if provider_id.is_empty() || model_id.is_empty() {
            return None;
        }
        let normalized_model = model_id.trim();
        if normalized_model.is_empty() {
            return None;
        }
        for key in self.list_provider_keys(provider_id) {
            if let Some(profile) = self.providers.get(&key) {
                let candidate = profile
                    .model_id
                    .clone()
                    .unwrap_or_else(|| derive_model_id(&profile.provider_key));
                if candidate == normalized_model {
                    return Some(candidate);
                }
                if let Some(alias_to_model) = profile.alias_to_model.as_ref() {
                    if let Some(canonical) = alias_to_model.get(normalized_model) {
                        if !canonical.trim().is_empty() {
                            return Some(canonical.clone());
                        }
                    }
                }
            }
        }
        None
    }

    pub(crate) fn build_target(&self, provider_key: &str) -> Option<Value> {
        let profile = self.providers.get(provider_key)?;
        let model_id = profile
            .model_id
            .clone()
            .unwrap_or_else(|| derive_model_id(&profile.provider_key));
        if model_id.is_empty() {
            return None;
        }
        let mut target = Map::new();
        target.insert(
            "providerKey".to_string(),
            Value::String(profile.provider_key.clone()),
        );
        target.insert(
            "providerType".to_string(),
            Value::String(profile.provider_type.clone()),
        );
        target.insert(
            "outboundProfile".to_string(),
            Value::String(
                profile
                    .outbound_profile
                    .clone()
                    .unwrap_or_else(|| profile.provider_protocol.clone()),
            ),
        );
        if let Some(comp) = profile.compatibility_profile.clone() {
            target.insert("compatibilityProfile".to_string(), Value::String(comp));
        }
        target.insert(
            "supportsMultimodal".to_string(),
            Value::Bool(self.has_capability(provider_key, "multimodal")),
        );
        target.insert(
            "supportsVision".to_string(),
            Value::Bool(self.has_capability(provider_key, "vision")),
        );
        if let Some(runtime) = profile.runtime_key.clone() {
            target.insert("runtimeKey".to_string(), Value::String(runtime.clone()));
            target.insert("concurrencyScopeKey".to_string(), Value::String(runtime));
        }
        target.insert("modelId".to_string(), Value::String(model_id));
        target.insert(
            "processMode".to_string(),
            Value::String(
                profile
                    .process_mode
                    .clone()
                    .unwrap_or_else(|| "chat".to_string()),
            ),
        );
        if let Some(resp) = profile.responses_config.clone() {
            target.insert("responsesConfig".to_string(), resp);
        }
        if let Some(streaming) = profile.streaming.clone() {
            target.insert("streaming".to_string(), streaming);
        }
        if let Some(max_tokens) = profile.max_context_tokens {
            target.insert(
                "maxContextTokens".to_string(),
                Value::Number(max_tokens.into()),
            );
        }
        if profile.server_tools_disabled {
            target.insert("serverToolsDisabled".to_string(), Value::Bool(true));
        }
        for (key, value) in &profile.provider_specific_config {
            target.insert(key.clone(), value.clone());
        }
        Some(Value::Object(target))
    }

    fn normalize_profile(key: &str, value: &Value) -> Option<ProviderProfile> {
        let map = value.as_object()?;
        let provider_key = map
            .get("providerKey")
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .trim()
            .to_string();
        if provider_key.is_empty() {
            return None;
        }
        let provider_type = map
            .get("providerType")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if provider_type.is_empty() {
            return None;
        }
        let provider_protocol = map
            .get("providerProtocol")
            .and_then(|v| v.as_str())
            .or_else(|| map.get("outboundProfile").and_then(|v| v.as_str()))
            .map(|v| normalize_provider_protocol(v, &provider_type))
            .unwrap_or_else(|| normalize_provider_protocol("", &provider_type));
        let enabled = map.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        let model_id = map
            .get("modelId")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| {
                let derived = derive_model_id(&provider_key);
                if derived.is_empty() {
                    None
                } else {
                    Some(derived)
                }
            });
        let runtime_key = map
            .get("runtimeKey")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string());
        let outbound_profile = map
            .get("outboundProfile")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let compatibility_profile = map
            .get("compatibilityProfile")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let process_mode = map
            .get("processMode")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let responses_config = map.get("responsesConfig").cloned();
        let streaming = map.get("streaming").cloned();
        let model_capabilities = read_model_capabilities_map(map.get("modelCapabilities"));
        let max_context_tokens = read_context_tokens(Some(map));
        let server_tools_disabled = map
            .get("serverToolsDisabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let series = map
            .get("series")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let alias_to_model = read_model_alias_map(map.get("aliasToModel"));
        // Collect provider-specific config keys (everything not in the common schema)
        let common_keys: &[&str] = &[
            "providerKey",
            "providerType",
            "providerProtocol",
            "enabled",
            "modelId",
            "runtimeKey",
            "outboundProfile",
            "compatibilityProfile",
            "processMode",
            "responsesConfig",
            "streaming",
            "modelCapabilities",
            "series",
            "aliasToModel",
            "maxContext",
            "max_context",
            "contextWindow",
            "context_window",
            "maxContextTokens",
            "max_context_tokens",
            "contextTokens",
            "context_tokens",
            "serverToolsDisabled",
        ];
        let mut provider_specific_config: HashMap<String, Value> = HashMap::new();
        for (k, v) in map {
            if !common_keys.contains(&k.as_str()) && !v.is_null() {
                provider_specific_config.insert(k.clone(), v.clone());
            }
        }
        Some(ProviderProfile {
            provider_key,
            provider_type,
            provider_protocol,
            enabled,
            outbound_profile,
            compatibility_profile,
            runtime_key,
            model_id,
            model_capabilities,
            process_mode,
            responses_config,
            streaming,
            max_context_tokens,
            server_tools_disabled,
            series,
            alias_to_model,
            provider_specific_config,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profile_context_tokens_use_largest_declared_context_window() {
        let mut registry = ProviderRegistry::default();
        let providers = json!({
            "mimo.key1.mimo-pro": {
                "providerKey": "mimo.key1.mimo-pro",
                "providerType": "openai",
                "modelId": "mimo-pro",
                "maxContext": 1048576,
                "maxContextTokens": 200000,
                "contextWindow": 200000
            }
        });
        registry.load(providers.as_object().unwrap());
        assert_eq!(
            registry
                .get("mimo.key1.mimo-pro")
                .and_then(|profile| profile.max_context_tokens),
            Some(1048576)
        );
    }

    #[test]
    fn responses_provider_without_explicit_capabilities_returns_false() {
        let mut registry = ProviderRegistry::default();
        let providers = json!({
            "sdfv.key1.gpt-5.4": {
                "providerKey": "sdfv.key1.gpt-5.4",
                "providerType": "responses",
                "modelId": "gpt-5.4"
            }
        });
        registry.load(providers.as_object().unwrap());
        assert!(!registry.has_capability("sdfv.key1.gpt-5.4", "multimodal"));
    }

    #[test]
    fn explicit_model_capability_is_detected() {
        let mut registry = ProviderRegistry::default();
        let providers = json!({
            "sdfv.key1.gpt-5.4": {
                "providerKey": "sdfv.key1.gpt-5.4",
                "providerType": "responses",
                "modelId": "gpt-5.4",
                "modelCapabilities": {
                    "gpt-5.4": ["multimodal", "web_search"]
                }
            }
        });
        registry.load(providers.as_object().unwrap());
        assert!(registry.has_capability("sdfv.key1.gpt-5.4", "multimodal"));
        assert!(registry.has_capability("sdfv.key1.gpt-5.4", "web_search"));
    }

    #[test]
    fn build_target_exposes_vision_capability_separately_from_multimodal() {
        let mut registry = ProviderRegistry::default();
        let providers = json!({
            "media.key1.vision-model": {
                "providerKey": "media.key1.vision-model",
                "providerType": "openai",
                "modelId": "vision-model",
                "modelCapabilities": {
                    "vision-model": ["vision"]
                }
            }
        });
        registry.load(providers.as_object().unwrap());
        let target = registry
            .build_target("media.key1.vision-model")
            .expect("vision target should be materialized");
        assert_eq!(target["supportsVision"], json!(true));
        assert_eq!(target["supportsMultimodal"], json!(false));
    }

    #[test]
    fn provider_without_explicit_multimodal_does_not_have_it_even_with_responses_compat() {
        let mut registry = ProviderRegistry::default();
        let providers = json!({
            "dibittai.crsa.gpt-5.4": {
                "providerKey": "dibittai.crsa.gpt-5.4",
                "providerType": "openai",
                "compatibilityProfile": "responses-crs",
                "modelId": "gpt-5.4"
            }
        });
        registry.load(providers.as_object().unwrap());
        assert!(!registry.has_capability("dibittai.crsa.gpt-5.4", "multimodal"));
        assert!(!registry.has_capability("dibittai.crsa.gpt-5.4", "web_search"));
    }

    #[test]
    fn alias_to_model_canonicalization_preserves_configured_case() {
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
        assert_eq!(
            registry.resolve_canonical_model_id("DF", "deepseek-v4-pro"),
            Some("DeepSeek-V4-Pro".to_string())
        );
        assert_eq!(
            registry.resolve_runtime_key_by_model("DF", "deepseek-v4-pro"),
            Some("DF.key1.DeepSeek-V4-Pro".to_string())
        );
    }
}

pub(crate) fn derive_model_id(provider_key: &str) -> String {
    let first_dot = provider_key.find('.');
    if let Some(first) = first_dot {
        if first + 1 >= provider_key.len() {
            return "".to_string();
        }
        let remainder = &provider_key[first + 1..];
        let second_dot = remainder.find('.');
        if let Some(second) = second_dot {
            if second + 1 >= remainder.len() {
                return remainder.trim().to_string();
            }
            return remainder[second + 1..].trim().to_string();
        }
        return remainder.trim().to_string();
    }
    "".to_string()
}

fn normalize_provider_protocol(outbound_profile: &str, provider_type: &str) -> String {
    let outbound = outbound_profile.trim().to_lowercase();
    match outbound.as_str() {
        "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-chat" => {
            return outbound;
        }
        "openai" | "chat" => return "openai-chat".to_string(),
        "responses" => return "openai-responses".to_string(),
        "anthropic" | "claude" => return "anthropic-messages".to_string(),
        "gemini" => return "gemini-chat".to_string(),
        _ => {}
    }
    match provider_type.trim().to_lowercase().as_str() {
        "responses" | "openai-responses" => "openai-responses".to_string(),
        "anthropic" | "claude" => "anthropic-messages".to_string(),
        "gemini" => "gemini-chat".to_string(),
        "openai" | "glm" | "qwen" | "deepseek" | "lmstudio" | "mock" | "" => {
            "openai-chat".to_string()
        }
        _ => "openai-chat".to_string(),
    }
}

fn read_model_capabilities_map(value: Option<&Value>) -> Option<HashMap<String, Vec<String>>> {
    let Some(map) = value.and_then(|v| v.as_object()) else {
        return None;
    };
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (model_id, caps_value) in map {
        let normalized_model = model_id.trim();
        if normalized_model.is_empty() {
            continue;
        }
        let caps = normalize_capability_list(caps_value, None);
        if !caps.is_empty() {
            out.insert(normalized_model.to_string(), caps);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn read_model_alias_map(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let Some(map) = value.and_then(|v| v.as_object()) else {
        return None;
    };
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for (alias, canonical_value) in map {
        let alias = alias.trim();
        let Some(canonical) = canonical_value.as_str().map(str::trim) else {
            continue;
        };
        if alias.is_empty() || canonical.is_empty() {
            continue;
        }
        out.insert(alias.to_string(), canonical.to_string());
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
