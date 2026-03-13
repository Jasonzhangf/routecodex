use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub(crate) struct ProviderProfile {
    pub provider_key: String,
    pub provider_type: String,
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
    pub deepseek: Option<Value>,
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
        let Some(model_capabilities) = profile.model_capabilities.as_ref() else {
            return false;
        };
        let Some(capabilities) = model_capabilities.get(&model_id) else {
            return false;
        };
        capabilities.iter().any(|item| item == capability)
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
                    return Some(key);
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
        if let Some(outbound) = profile.outbound_profile.clone() {
            target.insert("outboundProfile".to_string(), Value::String(outbound));
        }
        if let Some(comp) = profile.compatibility_profile.clone() {
            target.insert("compatibilityProfile".to_string(), Value::String(comp));
        }
        if let Some(runtime) = profile.runtime_key.clone() {
            target.insert("runtimeKey".to_string(), Value::String(runtime));
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
        if let Some(deepseek) = profile.deepseek.clone() {
            target.insert("deepseek".to_string(), deepseek);
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
        let model_capabilities = normalize_model_capabilities(map.get("modelCapabilities"));
        let max_context_tokens = map.get("maxContextTokens").and_then(|v| v.as_i64());
        let server_tools_disabled = map
            .get("serverToolsDisabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let deepseek = map.get("deepseek").cloned();
        Some(ProviderProfile {
            provider_key,
            provider_type,
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
            deepseek,
        })
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

fn normalize_model_capabilities(
    value: Option<&Value>,
) -> Option<HashMap<String, Vec<String>>> {
    let Some(map) = value.and_then(|v| v.as_object()) else {
        return None;
    };
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (model_id, caps_value) in map {
        let normalized_model = model_id.trim();
        if normalized_model.is_empty() {
            continue;
        }
        let caps = caps_value
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|s| !s.trim().is_empty())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
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
