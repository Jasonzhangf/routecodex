use serde_json::Value;

use super::super::provider_registry::ProviderRegistry;

fn alias_base(alias_key: &str) -> Option<String> {
    let trimmed = alias_key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = trimmed.split("::").next().unwrap_or(trimmed).trim();
    if base.is_empty() {
        return None;
    }
    Some(base.to_string())
}

pub(crate) fn alias_prefix_from_alias_key(alias_key: &str) -> Option<String> {
    let base = alias_base(alias_key)?;
    Some(format!("{}.", base))
}

pub(crate) fn build_antigravity_alias_key(
    provider_key: &str,
    registry: &ProviderRegistry,
) -> Option<String> {
    if !provider_key.starts_with("antigravity.") {
        return None;
    }
    let model_id = registry
        .get(provider_key)
        .and_then(|profile| profile.model_id.clone())
        .unwrap_or_default();
    if !model_id.to_lowercase().starts_with("gemini-") {
        return None;
    }
    let parts: Vec<&str> = provider_key.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    let alias = parts[1].trim();
    if alias.is_empty() {
        return None;
    }
    Some(format!("antigravity.{}::gemini", alias))
}

pub(crate) fn should_bind_antigravity_session(metadata: &Value) -> bool {
    let rt = metadata.get("__rt");
    let Some(rt_obj) = rt.and_then(|v| v.as_object()) else {
        return true;
    };
    if rt_obj
        .get("disableAntigravitySessionBinding")
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        return false;
    }
    if let Some(mode) = rt_obj.get("antigravitySessionBinding") {
        if mode.as_bool() == Some(false) {
            return false;
        }
        if let Some(text) = mode.as_str() {
            let normalized = text.trim().to_lowercase();
            if ["0", "false", "off", "disabled", "none"].contains(&normalized.as_str()) {
                return false;
            }
        }
    }
    true
}

pub(crate) fn should_avoid_antigravity_after_repeated_error(metadata: &Value) -> bool {
    let rt = metadata.get("__rt").and_then(|v| v.as_object());
    let Some(rt_obj) = rt else {
        return false;
    };
    if rt_obj
        .get("antigravityAvoidAllOnRetry")
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        return true;
    }
    let signature = rt_obj
        .get("antigravityRetryErrorSignature")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .unwrap_or("");
    let consecutive = rt_obj
        .get("antigravityRetryErrorConsecutive")
        .and_then(|v| v.as_i64())
        .map(|v| v.max(0))
        .unwrap_or(0);
    !signature.is_empty() && signature != "unknown" && consecutive >= 2
}
