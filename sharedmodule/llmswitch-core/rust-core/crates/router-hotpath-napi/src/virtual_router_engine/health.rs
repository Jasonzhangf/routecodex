use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHealthConfig {
    pub failure_threshold: Option<i64>,
    pub cooldown_ms: Option<i64>,
    pub fatal_cooldown_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHealthState {
    pub provider_key: String,
    pub state: String,
    pub failure_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_expires_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct ProviderInternalState {
    provider_key: String,
    state: String,
    failure_count: i64,
    cooldown_expires_at: Option<i64>,
    last_failure_at: Option<i64>,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderHealthManager {
    states: HashMap<String, ProviderInternalState>,
    config: ProviderHealthConfigNormalized,
}

#[derive(Debug, Clone)]
struct ProviderHealthConfigNormalized {
    failure_threshold: i64,
    cooldown_ms: i64,
}

impl ProviderHealthManager {
    fn canonicalize_provider_key(provider_key: &str) -> String {
        let lower = provider_key.trim().to_ascii_lowercase();
        let mut out = String::with_capacity(lower.len());
        let bytes = lower.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] == b'.' && i + 4 < bytes.len() && &bytes[i + 1..i + 4] == b"key" {
                let mut j = i + 4;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > i + 4 {
                    out.push('.');
                    out.push_str(&lower[i + 4..j]);
                    i = j;
                    continue;
                }
            }
            out.push(bytes[i] as char);
            i += 1;
        }
        out
    }

    pub(crate) fn new() -> Self {
        Self {
            states: HashMap::new(),
            config: ProviderHealthConfigNormalized::default(),
        }
    }

    pub(crate) fn configure(&mut self, config: Option<ProviderHealthConfig>) {
        if let Some(cfg) = config {
            self.config = ProviderHealthConfigNormalized {
                failure_threshold: cfg
                    .failure_threshold
                    .unwrap_or(DEFAULT_FAILURE_THRESHOLD)
                    .max(1),
                cooldown_ms: cfg.cooldown_ms.unwrap_or(DEFAULT_COOLDOWN_MS).max(5_000),
            };
        }
    }

    pub(crate) fn register_providers(&mut self, provider_keys: &[String]) {
        for key in provider_keys {
            let canonical = Self::canonicalize_provider_key(key);
            self.states
                .entry(canonical.clone())
                .or_insert_with(|| ProviderInternalState {
                    provider_key: canonical,
                    state: "healthy".to_string(),
                    failure_count: 0,
                    cooldown_expires_at: None,
                    last_failure_at: None,
                    reason: None,
                });
        }
    }

    pub(crate) fn record_failure(
        &mut self,
        provider_key: &str,
        reason: Option<String>,
        now_ms: i64,
    ) {
        let threshold = self.config.failure_threshold;
        let cooldown_ms = self.config.cooldown_ms;
        let state = self.get_state_mut(provider_key);

        if let Some(expiry) = state.cooldown_expires_at {
            if expiry > now_ms {
                return;
            }
            state.state = "healthy".to_string();
            state.failure_count = 0;
            state.cooldown_expires_at = None;
            state.last_failure_at = None;
            state.reason = None;
        }

        state.failure_count += 1;
        state.last_failure_at = Some(now_ms);
        if let Some(reason) = reason {
            state.reason = Some(reason);
        }

        if state.failure_count >= threshold {
            state.state = "tripped".to_string();
            state.cooldown_expires_at = Some(now_ms + cooldown_ms);
        }
    }

    pub(crate) fn record_success(&mut self, provider_key: &str) {
        let state = self.get_state_mut(provider_key);
        state.failure_count = 0;
        state.state = "healthy".to_string();
        state.cooldown_expires_at = None;
        state.last_failure_at = None;
        state.reason = None;
    }

    pub(crate) fn is_available(&mut self, provider_key: &str, now_ms: i64) -> bool {
        let state = self.get_state_mut(provider_key);
        match state.cooldown_expires_at {
            Some(expiry) if now_ms >= expiry => {
                state.failure_count = 0;
                state.state = "healthy".to_string();
                state.cooldown_expires_at = None;
                state.last_failure_at = None;
                state.reason = None;
                true
            }
            Some(_) => false,
            None => true,
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<ProviderHealthState> {
        self.states
            .values()
            .map(|state| ProviderHealthState {
                provider_key: state.provider_key.clone(),
                state: state.state.clone(),
                failure_count: state.failure_count,
                cooldown_expires_at: state.cooldown_expires_at,
            })
            .collect()
    }

    pub(crate) fn cooldown_remaining_ms(&self, provider_key: &str, now_ms: i64) -> Option<i64> {
        let canonical = Self::canonicalize_provider_key(provider_key);
        let state = self.states.get(&canonical)?;
        let expiry = state.cooldown_expires_at?;
        if expiry <= now_ms {
            return None;
        }
        Some(expiry - now_ms)
    }

    pub(crate) fn describe_state(&self, provider_key: &str) -> Option<Value> {
        let canonical = Self::canonicalize_provider_key(provider_key);
        let state = self.states.get(&canonical)?;
        Some(json!({
            "providerKey": state.provider_key,
            "state": state.state,
            "failureCount": state.failure_count,
            "cooldownExpiresAt": state.cooldown_expires_at,
            "lastFailureAt": state.last_failure_at,
            "reason": state.reason,
        }))
    }

    pub(crate) fn config(&self) -> ProviderHealthConfigNormalized {
        self.config.clone()
    }

    pub(crate) fn clear_runtime_state(&mut self) {
        for state in self.states.values_mut() {
            state.failure_count = 0;
            state.state = "healthy".to_string();
            state.cooldown_expires_at = None;
            state.last_failure_at = None;
            state.reason = None;
        }
    }

    pub(crate) fn export_persistable_state(&self, now_ms: i64) -> Value {
        let mut provider_cooldowns: Vec<Value> = self
            .states
            .values()
            .filter_map(|state| {
                if let Some(cooldown_expires_at) = state.cooldown_expires_at {
                    if cooldown_expires_at <= now_ms {
                        return None;
                    }
                }
                if state.failure_count <= 0 && state.cooldown_expires_at.is_none() {
                    return None;
                }
                let mut entry = json!({
                    "providerKey": state.provider_key,
                    "state": state.state,
                    "failureCount": state.failure_count,
                    "lastFailureAt": state.last_failure_at,
                    "reason": state.reason,
                });
                if let Some(cooldown_expires_at) = state.cooldown_expires_at {
                    entry["cooldownExpiresAt"] = json!(cooldown_expires_at);
                }
                Some(entry)
            })
            .collect();
        provider_cooldowns.sort_by(|a, b| {
            let a_key = a.get("providerKey").and_then(|v| v.as_str()).unwrap_or("");
            let b_key = b.get("providerKey").and_then(|v| v.as_str()).unwrap_or("");
            a_key.cmp(b_key)
        });
        json!({
            "version": 1,
            "providerCooldowns": provider_cooldowns
        })
    }

    pub(crate) fn import_persistable_state(&mut self, raw: &Value, now_ms: i64) -> bool {
        let mut pruned_expired = false;
        let Some(entries) = raw.get("providerCooldowns").and_then(|v| v.as_array()) else {
            return false;
        };
        for entry in entries {
            let Some(provider_key) = entry
                .get("providerKey")
                .or_else(|| entry.get("provider"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            let cooldown_expires_at = entry
                .get("cooldownExpiresAt")
                .or_else(|| entry.get("expires"))
                .and_then(|v| {
                    v.as_i64()
                        .or_else(|| v.as_u64().map(|value| value as i64))
                        .or_else(|| v.as_f64().map(|value| value.round() as i64))
                });
            if matches!(cooldown_expires_at, Some(expiry) if expiry <= now_ms) {
                pruned_expired = true;
                continue;
            }
            let failure_threshold = self.config.failure_threshold;
            let raw_failure_count = entry.get("failureCount").and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_u64().map(|value| value as i64))
                    .or_else(|| v.as_f64().map(|value| value.round() as i64))
            });
            if cooldown_expires_at.is_none() && raw_failure_count.unwrap_or(0) <= 0 {
                continue;
            }
            let state = self.get_state_mut(provider_key);
            state.cooldown_expires_at = cooldown_expires_at;
            state.failure_count = match cooldown_expires_at {
                Some(_) => raw_failure_count
                    .unwrap_or(failure_threshold)
                    .max(failure_threshold),
                None => raw_failure_count
                    .unwrap_or(0)
                    .clamp(0, failure_threshold.saturating_sub(1)),
            };
            state.state = match cooldown_expires_at {
                Some(_) => entry
                    .get("state")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("tripped")
                    .to_string(),
                None => "healthy".to_string(),
            };
            state.last_failure_at = entry.get("lastFailureAt").and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_u64().map(|value| value as i64))
                    .or_else(|| v.as_f64().map(|value| value.round() as i64))
            });
            state.reason = entry
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
        }
        pruned_expired
    }

    fn get_state_mut(&mut self, provider_key: &str) -> &mut ProviderInternalState {
        let canonical = Self::canonicalize_provider_key(provider_key);
        self.states
            .entry(canonical.clone())
            .or_insert_with(|| ProviderInternalState {
                provider_key: canonical,
                state: "healthy".to_string(),
                failure_count: 0,
                cooldown_expires_at: None,
                last_failure_at: None,
                reason: None,
            })
    }
}

impl Default for ProviderHealthConfigNormalized {
    fn default() -> Self {
        Self {
            failure_threshold: DEFAULT_FAILURE_THRESHOLD,
            cooldown_ms: DEFAULT_COOLDOWN_MS,
        }
    }
}

const DEFAULT_FAILURE_THRESHOLD: i64 = 3;
pub(crate) const DEFAULT_COOLDOWN_MS: i64 = 30 * 60_000;

#[cfg(test)]
mod tests {
    use super::*;

    fn state_for(manager: &ProviderHealthManager, provider_key: &str) -> ProviderHealthState {
        manager
            .snapshot()
            .into_iter()
            .find(|state| state.provider_key == provider_key)
            .expect("provider state")
    }

    #[test]
    fn record_failure_only_trips_on_third_strike() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);

        manager.record_failure("test-provider", Some("err-1".to_string()), 1_000);
        let first = state_for(&manager, "test-provider");
        assert_eq!(first.state, "healthy");
        assert_eq!(first.failure_count, 1);
        assert_eq!(first.cooldown_expires_at, None);

        manager.record_failure("test-provider", Some("err-2".to_string()), 2_000);
        let second = state_for(&manager, "test-provider");
        assert_eq!(second.state, "healthy");
        assert_eq!(second.failure_count, 2);
        assert_eq!(second.cooldown_expires_at, None);

        manager.record_failure("test-provider", Some("err-3".to_string()), 3_000);
        let third = state_for(&manager, "test-provider");
        assert_eq!(third.state, "tripped");
        assert_eq!(third.failure_count, 3);
        assert_eq!(third.cooldown_expires_at, Some(3_000 + DEFAULT_COOLDOWN_MS));
    }

    #[test]
    fn cooldown_expiry_restores_health_and_resets_strikes() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);

        manager.record_failure("test-provider", None, 1_000);
        manager.record_failure("test-provider", None, 2_000);
        manager.record_failure("test-provider", None, 3_000);

        assert!(!manager.is_available("test-provider", 3_000 + DEFAULT_COOLDOWN_MS - 1));
        assert!(manager.is_available("test-provider", 3_000 + DEFAULT_COOLDOWN_MS + 1));

        let healed = state_for(&manager, "test-provider");
        assert_eq!(healed.state, "healthy");
        assert_eq!(healed.failure_count, 0);
        assert_eq!(healed.cooldown_expires_at, None);
    }

    #[test]
    fn success_clears_partial_failure_window() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);

        manager.record_failure("test-provider", None, 1_000);
        manager.record_failure("test-provider", None, 2_000);
        manager.record_success("test-provider");
        manager.record_failure("test-provider", None, 3_000);

        let state = state_for(&manager, "test-provider");
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
    }

    #[test]
    fn record_failure_third_strike_marks_unavailable_until_expiry() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);

        manager.record_failure("test-provider", Some("err-1".to_string()), 1_000);
        manager.record_failure("test-provider", Some("err-2".to_string()), 2_000);
        manager.record_failure("test-provider", Some("err-3".to_string()), 3_000);
        let state = state_for(&manager, "test-provider");
        assert_eq!(state.state, "tripped");
        assert!(state.failure_count >= 3);
        assert_eq!(state.cooldown_expires_at, Some(3_000 + DEFAULT_COOLDOWN_MS));
        assert!(!manager.is_available("test-provider", 3_000 + DEFAULT_COOLDOWN_MS - 1));
        assert!(manager.is_available("test-provider", 3_000 + DEFAULT_COOLDOWN_MS + 1));
    }

    #[test]
    fn export_and_import_persisted_cooldown_state() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);
        manager.record_failure("test-provider", None, 1_000);
        manager.record_failure("test-provider", None, 2_000);
        manager.record_failure("test-provider", None, 3_000);

        let exported = manager.export_persistable_state(4_000);
        let entries = exported
            .get("providerCooldowns")
            .and_then(|v| v.as_array())
            .expect("providerCooldowns array");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].get("providerKey").and_then(|v| v.as_str()),
            Some("test-provider")
        );
        assert_eq!(
            entries[0].get("state").and_then(|v| v.as_str()),
            Some("tripped")
        );
        assert_eq!(
            entries[0].get("failureCount").and_then(|v| v.as_i64()),
            Some(3)
        );

        let mut restored = ProviderHealthManager::new();
        restored.register_providers(&["test-provider".to_string()]);
        let pruned = restored.import_persistable_state(&exported, 4_000);
        assert!(!pruned);

        let state = state_for(&restored, "test-provider");
        assert_eq!(state.state, "tripped");
        assert_eq!(state.failure_count, 3);
        assert_eq!(state.cooldown_expires_at, Some(3_000 + DEFAULT_COOLDOWN_MS));
        assert!(!restored.is_available("test-provider", 4_000));
    }

    #[test]
    fn export_and_import_persisted_partial_failure_window() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);
        manager.record_failure("test-provider", Some("err-1".to_string()), 1_000);

        let exported = manager.export_persistable_state(2_000);
        let entries = exported
            .get("providerCooldowns")
            .and_then(|v| v.as_array())
            .expect("providerCooldowns array");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].get("providerKey").and_then(|v| v.as_str()),
            Some("test-provider")
        );
        assert_eq!(
            entries[0].get("failureCount").and_then(|v| v.as_i64()),
            Some(1)
        );
        assert!(entries[0].get("cooldownExpiresAt").is_none());

        let mut restored = ProviderHealthManager::new();
        restored.register_providers(&["test-provider".to_string()]);
        let pruned = restored.import_persistable_state(&exported, 2_000);
        assert!(!pruned);

        let state = state_for(&restored, "test-provider");
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
        assert_eq!(state.cooldown_expires_at, None);
        assert!(restored.is_available("test-provider", 2_000));
    }

    #[test]
    fn import_legacy_provider_cooldown_shape() {
        let mut restored = ProviderHealthManager::new();
        restored.register_providers(&["test-provider".to_string()]);
        let raw = json!({
            "version": 1,
            "providerCooldowns": [{
                "provider": "test-provider",
                "expires": 123_000i64,
                "reason": "legacy"
            }]
        });

        let pruned = restored.import_persistable_state(&raw, 4_000);
        assert!(!pruned);

        let state = state_for(&restored, "test-provider");
        assert_eq!(state.state, "tripped");
        assert_eq!(state.failure_count, DEFAULT_FAILURE_THRESHOLD);
        assert_eq!(state.cooldown_expires_at, Some(123_000));
    }

    #[test]
    fn import_reports_pruned_expired_persisted_cooldown() {
        let mut restored = ProviderHealthManager::new();
        restored.register_providers(&["test-provider".to_string()]);
        let raw = json!({
            "version": 1,
            "providerCooldowns": [{
                "providerKey": "test-provider",
                "state": "tripped",
                "failureCount": 3,
                "cooldownExpiresAt": 4_000i64,
                "lastFailureAt": 1_000i64,
                "reason": "expired"
            }]
        });

        let pruned = restored.import_persistable_state(&raw, 4_001);

        assert!(pruned);
        let state = state_for(&restored, "test-provider");
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 0);
        assert_eq!(state.cooldown_expires_at, None);
        assert_eq!(
            restored.export_persistable_state(4_001),
            json!({
                "version": 1,
                "providerCooldowns": []
            })
        );
    }
}
