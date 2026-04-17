use serde::{Deserialize, Serialize};
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
    fatal_cooldown_ms: i64,
}

impl ProviderHealthManager {
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
            if !self.states.contains_key(key) {
                self.states.insert(
                    key.clone(),
                    ProviderInternalState {
                        provider_key: key.clone(),
                        state: "healthy".to_string(),
                        failure_count: 0,
                        cooldown_expires_at: None,
                        last_failure_at: None,
                        reason: None,
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
        state.last_failure_at = Some(now_ms);
        if let Some(reason) = reason {
            state.reason = Some(reason);
        }

        // Aggressive ban: auto-trip when reaching threshold (3 consecutive failures = 3 cycles cooldown)
        if state.failure_count >= threshold {
            state.state = "tripped".to_string();
            state.cooldown_expires_at = Some(now_ms + cooldown_unit * 3);
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
        state.state = "tripped".to_string();
        state.reason = reason;
        state.cooldown_expires_at = Some(now_ms + ttl);
        state.last_failure_at = Some(now_ms);
    }

    pub(crate) fn record_success(&mut self, provider_key: &str) {
        let state = self.get_state_mut(provider_key);
        state.failure_count = 0;
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

    pub(crate) fn config(&self) -> ProviderHealthConfigNormalized {
        self.config.clone()
    }

    fn get_state_mut(&mut self, provider_key: &str) -> &mut ProviderInternalState {
        if !self.states.contains_key(provider_key) {
            self.states.insert(
                provider_key.to_string(),
                ProviderInternalState {
                    provider_key: provider_key.to_string(),
                    state: "healthy".to_string(),
                    failure_count: 0,
                    cooldown_expires_at: None,
                    last_failure_at: None,
                    reason: None,
                },
            );
        }
        self.states.get_mut(provider_key).expect("state exists")
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
const DEFAULT_COOLDOWN_MS: i64 = 30_000;
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
        let state1 = states.iter().find(|s| s.provider_key == "test-provider").unwrap();
        assert_eq!(state1.failure_count, 1);
        assert_eq!(state1.state, "healthy");
        
        // Second failure: count=2, should NOT trip
        manager.record_failure("test-provider", Some("error2".to_string()), now + 1000);
        let states = manager.snapshot();
        let state2 = states.iter().find(|s| s.provider_key == "test-provider").unwrap();
        assert_eq!(state2.failure_count, 2);
        assert_eq!(state2.state, "healthy");
        
        // Third failure: count=3, should TRIP and set cooldown 3x
        manager.record_failure("test-provider", Some("error3".to_string()), now + 2000);
        let states = manager.snapshot();
        let state3 = states.iter().find(|s| s.provider_key == "test-provider").unwrap();
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
        let state = states.iter().find(|s| s.provider_key == "test-provider").unwrap();
        assert_eq!(state.failure_count, 0);
        assert_eq!(state.state, "healthy");
        
        // Another failure starts fresh
        manager.record_failure("test-provider", Some("error3".to_string()), now + 2000);
        let states = manager.snapshot();
        let state2 = states.iter().find(|s| s.provider_key == "test-provider").unwrap();
        assert_eq!(state2.failure_count, 1);
        assert_eq!(state2.state, "healthy");
    }
}
