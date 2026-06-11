use chrono::{Datelike, Local, TimeZone};
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
    consecutive_http_429_failures: i64,
    http_429_cooldown_cycles: i64,
    consecutive_recoverable_failures: i64,
    recoverable_cooldown_cycles: i64,
    persisted_503_reprobe_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Http429ControlOutcome {
    None,
    CooldownApplied,
    Blacklisted,
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
                        consecutive_http_429_failures: 0,
                        http_429_cooldown_cycles: 0,
                        consecutive_recoverable_failures: 0,
                        recoverable_cooldown_cycles: 0,
                        persisted_503_reprobe_available: false,
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
        state.consecutive_http_429_failures = 0;
        state.http_429_cooldown_cycles = 0;
        state.consecutive_recoverable_failures = 0;
        state.recoverable_cooldown_cycles = 0;
        state.persisted_503_reprobe_available = false;
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
        state.consecutive_http_429_failures = 0;
        state.http_429_cooldown_cycles = 0;
        state.consecutive_recoverable_failures = 0;
        state.recoverable_cooldown_cycles = 0;
        state.persisted_503_reprobe_available = false;
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
        state.consecutive_http_429_failures = 0;
        state.http_429_cooldown_cycles = 0;
        state.consecutive_recoverable_failures = 0;
        state.recoverable_cooldown_cycles = 0;
        state.persisted_503_reprobe_available = false;
        state.state = "tripped".to_string();
        state.reason = Some(PERSIST_REASON_HTTP_503_DAILY.to_string());
        state.cooldown_expires_at = Some(now_ms + ttl);
        state.last_failure_at = Some(now_ms);
    }

    pub(crate) fn record_success(&mut self, provider_key: &str) {
        {
            let state = self.get_state_mut(provider_key);
            state.failure_count = 0;
            state.consecutive_http_502_failures = 0;
            state.consecutive_http_429_failures = 0;
            state.http_429_cooldown_cycles = 0;
            state.consecutive_recoverable_failures = 0;
            state.recoverable_cooldown_cycles = 0;
            state.persisted_503_reprobe_available = false;
            state.state = "healthy".to_string();
            state.cooldown_expires_at = None;
            state.last_failure_at = None;
            state.reason = None;
        }
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
        state.consecutive_http_429_failures = 0;
        state.http_429_cooldown_cycles = 0;
        state.consecutive_recoverable_failures = 0;
        state.recoverable_cooldown_cycles = 0;
        state.persisted_503_reprobe_available = false;
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
                state.state = "healthy".to_string();
                state.failure_count = 0;
                state.cooldown_expires_at = None;
                state.last_failure_at = None;
                state.reason = None;
                state.consecutive_http_502_failures = 0;
                state.consecutive_http_429_failures = 0;
                state.consecutive_recoverable_failures = 0;
                state.persisted_503_reprobe_available = false;
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

    pub(crate) fn consume_persisted_503_reprobe_if_available(
        &mut self,
        provider_key: &str,
        now_ms: i64,
    ) -> bool {
        let canonical = Self::canonicalize_provider_key(provider_key);
        let Some(state) = self.states.get_mut(&canonical) else {
            return false;
        };
        if state.reason.as_deref() != Some(PERSIST_REASON_HTTP_503_DAILY) {
            return false;
        }
        if !state.persisted_503_reprobe_available {
            return false;
        }
        let active = state
            .cooldown_expires_at
            .map(|expiry| expiry > now_ms)
            .unwrap_or(false);
        if !active {
            state.persisted_503_reprobe_available = false;
            return false;
        }
        state.persisted_503_reprobe_available = false;
        state.state = "healthy".to_string();
        state.failure_count = 0;
        state.cooldown_expires_at = None;
        state.last_failure_at = None;
        state.reason = None;
        state.consecutive_http_502_failures = 0;
        state.consecutive_http_429_failures = 0;
        state.consecutive_recoverable_failures = 0;
        true
    }

    pub(crate) fn has_persisted_503_reprobe_available(
        &self,
        provider_key: &str,
        now_ms: i64,
    ) -> bool {
        let canonical = Self::canonicalize_provider_key(provider_key);
        let Some(state) = self.states.get(&canonical) else {
            return false;
        };
        if state.reason.as_deref() != Some(PERSIST_REASON_HTTP_503_DAILY) {
            return false;
        }
        if !state.persisted_503_reprobe_available {
            return false;
        }
        state
            .cooldown_expires_at
            .map(|expiry| expiry > now_ms)
            .unwrap_or(false)
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
            "consecutiveHttp502Failures": state.consecutive_http_502_failures,
            "consecutiveHttp429Failures": state.consecutive_http_429_failures,
            "http429CooldownCycles": state.http_429_cooldown_cycles,
        }))
    }

    pub(crate) fn config(&self) -> ProviderHealthConfigNormalized {
        self.config.clone()
    }

    pub(crate) fn clear_runtime_state(&mut self) {
        for state in self.states.values_mut() {
            state.state = "healthy".to_string();
            state.failure_count = 0;
            state.cooldown_expires_at = None;
            state.last_failure_at = None;
            state.reason = None;
            state.consecutive_http_502_failures = 0;
            state.consecutive_http_429_failures = 0;
            state.http_429_cooldown_cycles = 0;
            state.consecutive_recoverable_failures = 0;
            state.recoverable_cooldown_cycles = 0;
            state.persisted_503_reprobe_available = false;
        }
    }

    pub(crate) fn clear_imported_persisted_state(&mut self) {
        for state in self.states.values_mut() {
            if state.reason.as_deref() != Some(PERSIST_REASON_HTTP_503_DAILY) {
                continue;
            }
            if state.cooldown_expires_at.is_none() {
                continue;
            }
            state.state = "healthy".to_string();
            state.failure_count = 0;
            state.cooldown_expires_at = None;
            state.last_failure_at = None;
            state.reason = None;
            state.consecutive_http_502_failures = 0;
            state.consecutive_http_429_failures = 0;
            state.http_429_cooldown_cycles = 0;
            state.consecutive_recoverable_failures = 0;
            state.recoverable_cooldown_cycles = 0;
            state.persisted_503_reprobe_available = false;
        }
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

    pub(crate) fn import_persistable_state(
        &mut self,
        raw: &Value,
        now_ms: i64,
        allow_persisted_reprobe: bool,
    ) {
        let Some(entries) = raw.get("providerCooldowns").and_then(|v| v.as_array()) else {
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
            let canonical = Self::canonicalize_provider_key(provider_key);
            if !allow_persisted_reprobe {
                if let Some(existing) = self.states.get(&canonical) {
                    if existing.state == "healthy"
                        && existing.cooldown_expires_at.is_none()
                        && existing.reason.is_none()
                        && !existing.persisted_503_reprobe_available
                    {
                        continue;
                    }
                }
            }
            let existing_reprobe_available = self
                .states
                .get(&canonical)
                .map(|state| state.persisted_503_reprobe_available)
                .unwrap_or(false);
            self.cooldown_provider_until_midnight_persisted(provider_key, now_ms, expires_at);
            if let Some(state) = self.states.get_mut(&canonical) {
                state.persisted_503_reprobe_available =
                    allow_persisted_reprobe || existing_reprobe_available;
            }
        }
    }

    pub(crate) fn record_http_502_failure(
        &mut self,
        provider_key: &str,
        reason: Option<String>,
        now_ms: i64,
    ) {
        let base_threshold = self.config.failure_threshold.max(3);
        let state = self.get_state_mut(provider_key);
        let threshold = base_threshold;
        state.failure_count += 1;
        state.consecutive_http_502_failures += 1;
        state.consecutive_recoverable_failures += 1;
        state.persisted_503_reprobe_available = false;
        state.last_failure_at = Some(now_ms);
        if let Some(reason) = reason {
            state.reason = Some(reason);
        }
        if state.consecutive_recoverable_failures >= threshold {
            state.consecutive_recoverable_failures = 0;
            state.state = "tripped".to_string();
            state.cooldown_expires_at =
                Some(now_ms + next_recoverable_cooldown_ms(state.recoverable_cooldown_cycles));
            state.recoverable_cooldown_cycles += 1;
        }
    }

    pub(crate) fn record_http_429_failure(
        &mut self,
        provider_key: &str,
        reason: Option<String>,
        now_ms: i64,
    ) -> Http429ControlOutcome {
        const HTTP_429_THRESHOLD: i64 = 3;
        let state = self.get_state_mut(provider_key);
        state.failure_count += 1;
        state.consecutive_http_502_failures = 0;
        state.consecutive_http_429_failures += 1;
        state.consecutive_recoverable_failures += 1;
        state.persisted_503_reprobe_available = false;
        state.last_failure_at = Some(now_ms);
        if let Some(reason) = reason {
            state.reason = Some(reason);
        }

        if state.consecutive_http_429_failures < HTTP_429_THRESHOLD {
            return Http429ControlOutcome::None;
        }

        state.consecutive_http_429_failures = 0;
        state.state = "tripped".to_string();
        let cycle = state.http_429_cooldown_cycles;
        state.cooldown_expires_at = Some(now_ms + next_ladder_cooldown_ms(cycle));
        state.http_429_cooldown_cycles += 1;
        Http429ControlOutcome::CooldownApplied
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
                    consecutive_http_429_failures: 0,
                    http_429_cooldown_cycles: 0,
                    consecutive_recoverable_failures: 0,
                    recoverable_cooldown_cycles: 0,
                    persisted_503_reprobe_available: false,
                },
            );
        }
        self.states.get_mut(&canonical).expect("state exists")
    }

    pub(crate) fn record_recoverable_failure(
        &mut self,
        provider_key: &str,
        reason: Option<String>,
        now_ms: i64,
    ) -> Http429ControlOutcome {
        let state = self.get_state_mut(provider_key);
        let threshold = 3;
        state.failure_count += 1;
        state.consecutive_http_502_failures = 0;
        state.consecutive_http_429_failures = 0;
        state.consecutive_recoverable_failures += 1;
        state.persisted_503_reprobe_available = false;
        state.last_failure_at = Some(now_ms);
        if let Some(reason) = reason {
            state.reason = Some(reason);
        }
        if state.consecutive_recoverable_failures < threshold {
            return Http429ControlOutcome::None;
        }
        state.consecutive_recoverable_failures = 0;
        state.state = "tripped".to_string();
        state.cooldown_expires_at =
            Some(now_ms + next_recoverable_cooldown_ms(state.recoverable_cooldown_cycles));
        state.recoverable_cooldown_cycles += 1;
        Http429ControlOutcome::CooldownApplied
    }
}

fn compute_cooldown_until_next_local_midnight_ms(now_ms: i64) -> i64 {
    if now_ms <= 0 {
        return 24 * 60 * 60_000;
    }
    let Some(current) = Local.timestamp_millis_opt(now_ms).single() else {
        return 24 * 60 * 60_000;
    };
    let Some(next_midnight) = Local
        .with_ymd_and_hms(current.year(), current.month(), current.day(), 0, 0, 0)
        .single()
        .and_then(|dt| dt.checked_add_days(chrono::Days::new(1)))
    else {
        return 24 * 60 * 60_000;
    };
    let ttl = next_midnight.timestamp_millis() - now_ms;
    if ttl > 0 {
        ttl
    } else {
        24 * 60 * 60_000
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
const LADDER_COOLDOWN_30M_MS: i64 = 30 * 60_000;
const LADDER_COOLDOWN_3H_MS: i64 = 3 * 60 * 60_000;

fn next_ladder_cooldown_ms(cycles: i64) -> i64 {
    if cycles <= 0 {
        return LADDER_COOLDOWN_30M_MS;
    }
    match cycles.rem_euclid(2) {
        0 => LADDER_COOLDOWN_30M_MS,
        _ => LADDER_COOLDOWN_3H_MS,
    }
}

fn next_recoverable_cooldown_ms(cycles: i64) -> i64 {
    if cycles <= 0 {
        return LADDER_COOLDOWN_30M_MS;
    }
    match cycles.rem_euclid(2) {
        0 => LADDER_COOLDOWN_30M_MS,
        _ => LADDER_COOLDOWN_3H_MS,
    }
}

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

        // Third failure: count=3, should TRIP and use the configured cooldown window.
        manager.record_failure("test-provider", Some("error3".to_string()), now + 2000);
        let states = manager.snapshot();
        let state3 = states
            .iter()
            .find(|s| s.provider_key == "test-provider")
            .unwrap();
        assert_eq!(state3.failure_count, 3);
        assert_eq!(state3.state, "tripped");
        assert_eq!(
            state3.cooldown_expires_at,
            Some(now + 2000 + DEFAULT_COOLDOWN_MS)
        );

        // Should not be available during cooldown
        assert!(!manager.is_available("test-provider", now + 2000 + 50_000));

        // Should be available after cooldown expires
        assert!(manager.is_available("test-provider", now + 2000 + DEFAULT_COOLDOWN_MS + 1));
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

    #[test]
    fn test_http_429_three_strikes_trigger_cooldown_ladder_30m_3h_cycle() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);
        let now = 10_000i64;

        // first cycle: 3 consecutive 429 -> 30m cooldown
        assert_eq!(
            manager.record_http_429_failure("test-provider", Some("HTTP_429".to_string()), now),
            Http429ControlOutcome::None
        );
        assert_eq!(
            manager.record_http_429_failure("test-provider", Some("HTTP_429".to_string()), now + 1),
            Http429ControlOutcome::None
        );
        assert_eq!(
            manager.record_http_429_failure("test-provider", Some("HTTP_429".to_string()), now + 2),
            Http429ControlOutcome::CooldownApplied
        );
        let first = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-provider")
            .expect("provider state");
        assert_eq!(first.state, "tripped");
        assert!(first.cooldown_expires_at.is_some());

        // cooldown passes -> healthy and counters reset
        assert!(manager.is_available(
            "test-provider",
            first.cooldown_expires_at.expect("expiry") + 1
        ));

        let first_ttl = first.cooldown_expires_at.expect("expiry") - now;
        assert!(first_ttl > 29 * 60_000 && first_ttl <= 31 * 60_000);

        // second cycle: 3 consecutive 429 -> 3h cooldown (alternating ladder)
        assert_eq!(
            manager.record_http_429_failure(
                "test-provider",
                Some("HTTP_429".to_string()),
                first.cooldown_expires_at.expect("expiry") + 2
            ),
            Http429ControlOutcome::None
        );
        assert_eq!(
            manager.record_http_429_failure(
                "test-provider",
                Some("HTTP_429".to_string()),
                first.cooldown_expires_at.expect("expiry") + 3
            ),
            Http429ControlOutcome::None
        );
        assert_eq!(
            manager.record_http_429_failure(
                "test-provider",
                Some("HTTP_429".to_string()),
                first.cooldown_expires_at.expect("expiry") + 4
            ),
            Http429ControlOutcome::CooldownApplied
        );
        let second = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-provider")
            .expect("provider state");
        assert_eq!(second.state, "tripped");
        let second_expiry = second.cooldown_expires_at.expect("second expiry");
        let second_ttl = second_expiry - (first.cooldown_expires_at.expect("expiry") + 4);
        assert!(
            second_ttl > (3 * 60 * 60_000 - 60_000) && second_ttl <= (3 * 60 * 60_000 + 60_000)
        );

        assert!(manager.is_available("test-provider", second_expiry + 1));

        // third cycle: 3 consecutive 429 -> 30m cooldown (alternating ladder)
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            second_expiry + 2,
        );
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            second_expiry + 3,
        );
        assert_eq!(
            manager.record_http_429_failure(
                "test-provider",
                Some("HTTP_429".to_string()),
                second_expiry + 4
            ),
            Http429ControlOutcome::CooldownApplied
        );
        let third = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-provider")
            .expect("provider state");
        let third_ttl = third.cooldown_expires_at.expect("third expiry") - (second_expiry + 4);
        assert!(third_ttl > 29 * 60_000 && third_ttl <= 31 * 60_000);
    }

    #[test]
    fn test_http_429_ladder_alternates_30m_3h_30m_3h() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-provider".to_string()]);
        let now = 1_747_800_000_000i64;

        // First 3x 429 => 30m
        let _ = manager.record_http_429_failure("test-provider", Some("HTTP_429".to_string()), now);
        let _ =
            manager.record_http_429_failure("test-provider", Some("HTTP_429".to_string()), now + 1);
        let _ =
            manager.record_http_429_failure("test-provider", Some("HTTP_429".to_string()), now + 2);
        let first = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-provider")
            .expect("provider state");
        let first_expiry = first.cooldown_expires_at.expect("cooldown expiry");
        assert!(manager.is_available("test-provider", first_expiry + 1));

        // Second 3x 429 => 3h (cycle 1 in alternating ladder)
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            first_expiry + 2,
        );
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            first_expiry + 3,
        );
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            first_expiry + 4,
        );
        let second = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-provider")
            .expect("provider state");
        let second_expiry = second.cooldown_expires_at.expect("second cooldown expiry");
        let second_ttl = second_expiry - (first_expiry + 4);
        assert!(
            second_ttl > (3 * 60 * 60_000 - 60_000) && second_ttl <= (3 * 60 * 60_000 + 60_000)
        );
        assert!(manager.is_available("test-provider", second_expiry + 1));

        // Third 3x 429 => 30m (cycle 2 in alternating ladder)
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            second_expiry + 2,
        );
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            second_expiry + 3,
        );
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            second_expiry + 4,
        );
        let third = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-provider")
            .expect("provider state");
        let third_expiry = third.cooldown_expires_at.expect("third cooldown expiry");

        let third_ttl = third_expiry - (second_expiry + 4);
        assert!(third_ttl > 29 * 60_000 && third_ttl <= 31 * 60_000);

        assert!(manager.is_available("test-provider", third_expiry + 1));

        // Fourth 3x 429 => 3h
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            third_expiry + 2,
        );
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            third_expiry + 3,
        );
        let _ = manager.record_http_429_failure(
            "test-provider",
            Some("HTTP_429".to_string()),
            third_expiry + 4,
        );
        let fourth = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-provider")
            .expect("provider state");
        let fourth_ttl =
            fourth.cooldown_expires_at.expect("fourth cooldown expiry") - (third_expiry + 4);
        assert!(
            fourth_ttl > (3 * 60 * 60_000 - 60_000) && fourth_ttl <= (3 * 60 * 60_000 + 60_000)
        );
    }

    #[test]
    fn test_http_429_ladder_cycle_duration_function_alternates() {
        assert_eq!(next_ladder_cooldown_ms(-1), 30 * 60_000);
        assert_eq!(next_ladder_cooldown_ms(0), 30 * 60_000);
        assert_eq!(next_ladder_cooldown_ms(1), 3 * 60 * 60_000);
        assert_eq!(next_ladder_cooldown_ms(2), 30 * 60_000);
        assert_eq!(next_ladder_cooldown_ms(3), 3 * 60 * 60_000);
    }

    // ========== 黑盒红测：锁定 ProviderHealthManager 公共行为 ==========

    #[test]
    fn health_new_creates_empty_manager() {
        let manager = ProviderHealthManager::new();
        let snapshot = manager.snapshot();
        assert!(snapshot.is_empty());
    }

    #[test]
    fn health_register_providers_appears_in_snapshot() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["provider-a".to_string(), "provider-b".to_string()]);
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.len(), 2);
        let keys: Vec<&str> = snapshot.iter().map(|s| s.provider_key.as_str()).collect();
        assert!(keys.contains(&"provider-a"));
        assert!(keys.contains(&"provider-b"));
    }

    #[test]
    fn health_record_failure_increments_count() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.record_failure("test-p", Some("err1".to_string()), 1000);
        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.failure_count, 1);
        assert_eq!(s.state, "healthy");

        manager.record_failure("test-p", Some("err2".to_string()), 2000);
        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.failure_count, 2);
    }

    #[test]
    fn health_record_success_resets_failure_count() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.record_failure("test-p", Some("err1".to_string()), 1000);
        manager.record_failure("test-p", Some("err2".to_string()), 2000);
        manager.record_success("test-p");

        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.failure_count, 0);
        assert_eq!(s.state, "healthy");
    }

    #[test]
    fn health_cooldown_provider_makes_unavailable() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.cooldown_provider("test-p", Some("manual".to_string()), Some(5000), 1000);
        assert!(!manager.is_available("test-p", 3000));
        assert!(manager.is_available("test-p", 6000));
    }

    #[test]
    fn health_trip_provider_marks_tripped() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.trip_provider("test-p", Some("manual".to_string()), Some(60_000), 1000);
        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.state, "tripped");
        assert!(!manager.is_available("test-p", 1000 + 30_000));
        assert!(manager.is_available("test-p", 1000 + 60_001));
    }

    #[test]
    fn health_snapshot_returns_all_registered_providers() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["a".to_string(), "b".to_string(), "c".to_string()]);

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.len(), 3);
    }

    #[test]
    fn health_snapshot_for_unregistered_is_empty() {
        let mut manager = ProviderHealthManager::new();
        let snapshot = manager.snapshot();
        assert!(snapshot.is_empty());
    }

    #[test]
    fn health_config_returns_defaults() {
        let mut manager = ProviderHealthManager::new();
        let config = manager.config();
        assert!(config.cooldown_ms > 0);
    }

    #[test]
    fn health_cooldown_remaining_ms_during_cooldown() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.cooldown_provider("test-p", Some("manual".to_string()), Some(5000), 60_000);
        let remaining = manager.cooldown_remaining_ms("test-p", 30_000);
        assert!(remaining.is_some());
        assert!(remaining.unwrap() > 0);
    }

    #[test]
    fn health_cooldown_remaining_ms_after_cooldown() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.cooldown_provider("test-p", Some("manual".to_string()), Some(5000), 60_000);
        let remaining = manager.cooldown_remaining_ms("test-p", 70_000);
        assert!(remaining.is_none() || remaining == Some(0));
    }

    #[test]
    fn health_record_http_502_failure_sets_cooldown() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        // Need 3 failures to reach threshold.max(3)
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), 1000);
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), 2000);
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), 3000);
        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.state, "tripped");
        assert!(s.cooldown_expires_at.is_some());
    }

    #[test]
    fn health_record_recoverable_failure_sets_cooldown() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        // Need multiple failures to trip
        manager.record_recoverable_failure("test-p", Some("timeout".to_string()), 1000);
        manager.record_recoverable_failure("test-p", Some("timeout".to_string()), 2000);
        manager.record_recoverable_failure("test-p", Some("timeout".to_string()), 3000);
        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.state, "tripped");
    }

    #[test]
    fn health_recoverable_cooldown_reentry_requires_three_failures_for_long_cooldown() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);
        let now = 1_747_800_000_000i64;

        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now);
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 1);
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 2);
        let first = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .expect("provider state");
        let first_expiry = first.cooldown_expires_at.expect("first expiry");
        assert_eq!(first_expiry - (now + 2), 30 * 60_000);
        assert!(!manager.is_available("test-p", first_expiry - 1));
        assert!(manager.is_available("test-p", first_expiry + 1));

        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), first_expiry + 2);
        assert!(manager.is_available("test-p", first_expiry + 3));
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), first_expiry + 4);
        assert!(manager.is_available("test-p", first_expiry + 5));
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), first_expiry + 6);
        let second = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .expect("provider state");
        let second_expiry = second.cooldown_expires_at.expect("second expiry");
        assert_eq!(second_expiry - (first_expiry + 6), 3 * 60 * 60_000);
        assert!(!manager.is_available("test-p", second_expiry - 1));
        assert!(manager.is_available("test-p", second_expiry + 1));

        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), second_expiry + 2);
        assert!(manager.is_available("test-p", second_expiry + 3));
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), second_expiry + 4);
        assert!(manager.is_available("test-p", second_expiry + 5));
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), second_expiry + 6);
        let third = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .expect("provider state");
        let third_expiry = third.cooldown_expires_at.expect("third expiry");
        assert_eq!(third_expiry - (second_expiry + 6), 30 * 60_000);
    }

    #[test]
    fn health_recoverable_failure_during_active_cooldown_does_not_extend() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);
        let now = 1_747_800_000_000i64;

        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now);
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 1);
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 2);
        let first = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .expect("provider state");
        let first_expiry = first.cooldown_expires_at.expect("first expiry");
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 3);

        let state = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .expect("provider state");
        let expiry = state.cooldown_expires_at.expect("active expiry");
        assert_eq!(expiry, first_expiry);
    }

    #[test]
    fn health_recoverable_success_clears_failure_window() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);
        let now = 1_747_800_000_000i64;

        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now);
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 1);
        manager.record_success("test-p");
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 2);
        assert!(manager.is_available("test-p", now + 3));
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 4);
        assert!(manager.is_available("test-p", now + 5));
        manager.record_http_502_failure("test-p", Some("HTTP_502".to_string()), now + 6);

        let state = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .expect("provider state");
        let expiry = state.cooldown_expires_at.expect("expiry");
        assert_eq!(expiry - (now + 6), 30 * 60_000);
    }

    #[test]
    fn health_export_import_roundtrip() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);
        // Use persisted 503 daily cooldown (only this type is exported)
        manager.cooldown_provider_until_midnight_persisted("test-p", 1000, 31_000);

        let exported = manager.export_persistable_state(2000);
        assert!(exported.is_object(), "exported state should be an object");
        let cooldowns = exported
            .get("providerCooldowns")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(cooldowns.len(), 1, "should export one cooldown entry");

        let mut manager2 = ProviderHealthManager::new();
        // Use allow_persisted_reprobe=true so import doesn't skip existing healthy entries
        manager2.import_persistable_state(&exported, 2000, true);

        // After import, cooldown should be restored
        let s = manager2
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert!(
            s.cooldown_expires_at.is_some(),
            "cooldown should be restored after import"
        );
    }

    #[test]
    fn health_clear_runtime_state_resets_to_healthy() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.record_failure("test-p", Some("err".to_string()), 1000);
        manager.cooldown_provider("test-p", Some("manual".to_string()), Some(2000), 60_000);

        manager.clear_runtime_state();
        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.state, "healthy");
        assert_eq!(s.failure_count, 0);
    }

    #[test]
    fn health_describe_state_for_unregistered_is_none() {
        let manager = ProviderHealthManager::new();
        assert!(manager.describe_state("nonexistent").is_none());
    }

    #[test]
    fn health_cooldown_until_midnight_persisted_sets_cooldown() {
        let mut manager = ProviderHealthManager::new();
        manager.register_providers(&["test-p".to_string()]);

        manager.cooldown_provider_until_midnight_persisted("test-p", 1000, 60_000);
        let s = manager
            .snapshot()
            .into_iter()
            .find(|s| s.provider_key == "test-p")
            .unwrap();
        assert_eq!(s.state, "tripped");
        assert!(s.cooldown_expires_at.is_some());
        // Should be available after cooldown
        let expiry = s.cooldown_expires_at.unwrap();
        assert!(manager.is_available("test-p", expiry + 1));
    }
}
