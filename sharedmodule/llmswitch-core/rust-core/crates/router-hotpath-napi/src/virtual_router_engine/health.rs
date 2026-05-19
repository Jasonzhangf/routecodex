use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

const PERSIST_REASON_HTTP_503_DAILY: &str = "__http_503_daily_cooldown__";

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
    consecutive_http_502_failures: i64,
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
    fatal_cooldown_ms: i64,
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
            let normalized_cooldown = (cfg.cooldown_ms.unwrap_or(DEFAULT_COOLDOWN_MS)).max(5_000);
            let fatal_candidate = cfg
                .fatal_cooldown_ms
                .unwrap_or(DEFAULT_FATAL_COOLDOWN_MS)
                .max(normalized_cooldown);
            self.config = ProviderHealthConfigNormalized {
                failure_threshold: (cfg.failure_threshold.unwrap_or(DEFAULT_FAILURE_THRESHOLD))
                    .max(1),
                cooldown_ms: normalized_cooldown,
                fatal_cooldown_ms: fatal_candidate,
            };
        }
    }

    pub(crate) fn register_providers(&mut self, provider_keys: &[String]) {
        for key in provider_keys {
            let canonical = Self::canonicalize_provider_key(key);
            if !self.states.contains_key(&canonical) {
                self.states.insert(
                    canonical.clone(),
                    ProviderInternalState {
                        provider_key: canonical,
                        state: "healthy".to_string(),
                        failure_count: 0,
                        cooldown_expires_at: None,
                        last_failure_at: None,
                        reason: None,
                        consecutive_http_502_failures: 0,
                    },
                );
            }
        }
    }

    pub(crate) fn record_failure(
        &mut self,
        provider_key: &str,
        reason: Option<String>,
        now_ms: i64,
    ) {
        // Read config values before borrowing self
        let threshold = self.config.failure_threshold;
        let cooldown_unit = self.config.cooldown_ms;

        let state = self.get_state_mut(provider_key);
        state.failure_count += 1;
        state.consecutive_http_502_failures = 0;
        state.last_failure_at = Some(now_ms);
        if let Some(reason) = reason {
            state.reason = Some(reason);
        }

        // Unified policy: any consecutive failures reaching threshold are cooled down for 30 minutes.
        if state.failure_count >= threshold {
            state.state = "tripped".to_string();
            state.cooldown_expires_at = Some(now_ms + cooldown_unit);
        }
    }

    pub(crate) fn cooldown_provider(
        &mut self,
        provider_key: &str,
        reason: Option<String>,
        override_ms: Option<i64>,
        now_ms: i64,
    ) {
        let ttl = override_ms.unwrap_or(self.config.cooldown_ms);
        let state = self.get_state_mut(provider_key);
        state.failure_count += 1;
        state.consecutive_http_502_failures = 0;
        state.state = "tripped".to_string();
        state.reason = reason;
        state.cooldown_expires_at = Some(now_ms + ttl);
        state.last_failure_at = Some(now_ms);
    }

    pub(crate) fn cooldown_provider_until_midnight_persisted(
        &mut self,
        provider_key: &str,
        now_ms: i64,
        expires_at_ms: i64,
    ) {
        let ttl = (expires_at_ms - now_ms).max(1);
        let state = self.get_state_mut(provider_key);
        state.failure_count += 1;
        state.consecutive_http_502_failures = 0;
        state.state = "tripped".to_string();
        state.reason = Some(PERSIST_REASON_HTTP_503_DAILY.to_string());
        state.cooldown_expires_at = Some(now_ms + ttl);
        state.last_failure_at = Some(now_ms);
    }

    pub(crate) fn record_success(&mut self, provider_key: &str) {
        let state = self.get_state_mut(provider_key);
        state.failure_count = 0;
        state.consecutive_http_502_failures = 0;
        state.state = "healthy".to_string();
        state.cooldown_expires_at = None;
        state.last_failure_at = None;
        state.reason = None;
    }

    pub(crate) fn trip_provider(
        &mut self,
        provider_key: &str,
        reason: Option<String>,
        cooldown_override_ms: Option<i64>,
        now_ms: i64,
    ) {
        let failure_threshold = self.config.failure_threshold;
        let ttl = cooldown_override_ms.unwrap_or(self.config.fatal_cooldown_ms);
        let state = self.get_state_mut(provider_key);
        state.failure_count = state.failure_count.max(failure_threshold);
        state.consecutive_http_502_failures = 0;
        state.state = "tripped".to_string();
        state.reason = reason;
        state.cooldown_expires_at = Some(now_ms + ttl);
        state.last_failure_at = Some(now_ms);
    }

    pub(crate) fn is_available(&mut self, provider_key: &str, now_ms: i64) -> bool {
        let state = self.get_state_mut(provider_key);
        if state.state == "healthy" {
            return true;
        }
        if let Some(expiry) = state.cooldown_expires_at {
            if now_ms >= expiry {
                self.record_success(provider_key);
                return true;
            }
        }
        false
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

    pub(crate) fn config(&self) -> ProviderHealthConfigNormalized {
        self.config.clone()
    }

    pub(crate) fn export_persistable_state(&self, now_ms: i64) -> Value {
        let entries: Vec<Value> = self
            .states
            .values()
            .filter_map(|state| {
                let expiry = state.cooldown_expires_at?;
                if expiry <= now_ms {
                    return None;
                }
                if state.reason.as_deref() != Some(PERSIST_REASON_HTTP_503_DAILY) {
                    return None;
                }
                Some(json!({
                    "providerKey": state.provider_key,
                    "cooldownExpiresAt": expiry,
                    "reason": PERSIST_REASON_HTTP_503_DAILY
                }))
            })
            .collect();
        json!({ "version": 1, "providerCooldowns": entries })
    }

    pub(crate) fn import_persistable_state(&mut self, raw: &Value, now_ms: i64) {
        let Some(entries) = raw
            .get("providerCooldowns")
            .and_then(|v| v.as_array())
        else {
            return;
        };
        for entry in entries {
            let Some(provider_key) = entry.get("providerKey").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(expires_at) = entry
                .get("cooldownExpiresAt")
                .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|x| x as i64)))
            else {
                continue;
            };
            if expires_at <= now_ms {
                continue;
            }
            self.cooldown_provider_until_midnight_persisted(provider_key, now_ms, expires_at);
        }
    }

    pub(crate) fn record_http_502_failure(&mut self, provider_key: &str, reason: Option<String>, now_ms: i64) {
        let threshold = self.config.failure_threshold.max(3);
        let cooldown_ms = self.config.cooldown_ms;
        let state = self.get_state_mut(provider_key);
        state.failure_count += 1;
        state.consecutive_http_502_failures += 1;
        state.last_failure_at = Some(now_ms);
        if let Some(reason) = reason {
            state.reason = Some(reason);
        }
        if state.consecutive_http_502_failures >= threshold {
            state.state = "tripped".to_string();
            state.cooldown_expires_at = Some(now_ms + cooldown_ms);
        }
    }

    fn get_state_mut(&mut self, provider_key: &str) -> &mut ProviderInternalState {
        let canonical = Self::canonicalize_provider_key(provider_key);
        if !self.states.contains_key(&canonical) {
            self.states.insert(
                canonical.clone(),
                ProviderInternalState {
                    provider_key: canonical.clone(),
                    state: "healthy".to_string(),
                    failure_count: 0,
                    cooldown_expires_at: None,
                    last_failure_at: None,
                    reason: None,
                    consecutive_http_502_failures: 0,
                },
            );
        }
        self.states.get_mut(&canonical).expect("state exists")
    }
}

impl Default for ProviderHealthConfigNormalized {
    fn default() -> Self {
        Self {
            failure_threshold: DEFAULT_FAILURE_THRESHOLD,
            cooldown_ms: DEFAULT_COOLDOWN_MS,
            fatal_cooldown_ms: DEFAULT_FATAL_COOLDOWN_MS,
        }
    }
}

const DEFAULT_FAILURE_THRESHOLD: i64 = 3;
pub(crate) const DEFAULT_COOLDOWN_MS: i64 = 30 * 60_000;
const DEFAULT_FATAL_COOLDOWN_MS: i64 = 120_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aggressive_ban_auto_trip_on_threshold() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);

        let now = 1000i64;

        // First failure: count=1, should NOT trip
        manager.record_failure("test-provider", Some("error1".to_string()), now);
        let states = manager.snapshot();
        let state1 = states
            .iter()
            .find(|s| s.provider_key == "test-provider")
            .unwrap();
        assert_eq!(state1.failure_count, 1);
        assert_eq!(state1.state, "healthy");

        // Second failure: count=2, should NOT trip
        manager.record_failure("test-provider", Some("error2".to_string()), now + 1000);
        let states = manager.snapshot();
        let state2 = states
            .iter()
            .find(|s| s.provider_key == "test-provider")
            .unwrap();
        assert_eq!(state2.failure_count, 2);
        assert_eq!(state2.state, "healthy");

        // Third failure: count=3, should TRIP and set cooldown 3x
        manager.record_failure("test-provider", Some("error3".to_string()), now + 2000);
        let states = manager.snapshot();
        let state3 = states
            .iter()
            .find(|s| s.provider_key == "test-provider")
            .unwrap();
        assert_eq!(state3.failure_count, 3);
        assert_eq!(state3.state, "tripped");
        // cooldown = 30_000 * 3 = 90_000, expires_at = now + 2000 + 90_000
        assert_eq!(state3.cooldown_expires_at, Some(now + 2000 + 90_000));

        // Should not be available during cooldown
        assert!(!manager.is_available("test-provider", now + 2000 + 50_000));

        // Should be available after cooldown expires
        assert!(manager.is_available("test-provider", now + 2000 + 90_000 + 1));
    }

    #[test]
    fn test_aggressive_ban_success_clears_count() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);

        let now = 1000i64;

        // Two failures
        manager.record_failure("test-provider", Some("error1".to_string()), now);
        manager.record_failure("test-provider", Some("error2".to_string()), now + 1000);

        // Success clears everything
        manager.record_success("test-provider");
        let states = manager.snapshot();
        let state = states
            .iter()
            .find(|s| s.provider_key == "test-provider")
            .unwrap();
        assert_eq!(state.failure_count, 0);
        assert_eq!(state.state, "healthy");

        // Another failure starts fresh
        manager.record_failure("test-provider", Some("error3".to_string()), now + 2000);
        let states = manager.snapshot();
        let state2 = states
            .iter()
            .find(|s| s.provider_key == "test-provider")
            .unwrap();
        assert_eq!(state2.failure_count, 1);
        assert_eq!(state2.state, "healthy");
    }
}
