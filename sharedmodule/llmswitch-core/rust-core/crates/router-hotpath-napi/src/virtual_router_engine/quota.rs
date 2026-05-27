use super::provider_registry::ProviderProfile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderQuotaState {
    pub provider_key: String,
    pub in_pool: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blacklist_until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_at_ms: Option<i64>,
    pub consecutive_error_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderQuotaHostSnapshotEntry {
    pub provider_key: String,
    pub in_pool: bool,
    pub reason: String,
    pub auth_type: String,
    pub auth_issue: Option<Value>,
    pub priority_tier: i64,
    pub cooldown_until: Option<i64>,
    pub cooldown_keeps_pool: Option<bool>,
    pub blacklist_until: Option<i64>,
    pub reset_at: Option<i64>,
    pub last_error_series: Option<String>,
    pub last_error_code: Option<String>,
    pub last_error_at_ms: Option<i64>,
    pub consecutive_error_count: i64,
    pub selection_penalty: i64,
    pub last_provider_guard_applied: bool,
}

#[derive(Debug, Clone)]
struct ProviderQuotaInternalState {
    provider_key: String,
    in_pool: bool,
    reason: String,
    auth_type: String,
    auth_issue: Option<Value>,
    priority_tier: i64,
    cooldown_until: Option<i64>,
    cooldown_keeps_pool: Option<bool>,
    blacklist_until: Option<i64>,
    reset_at: Option<i64>,
    last_error_series: Option<String>,
    last_error_code: Option<String>,
    last_error_at_ms: Option<i64>,
    consecutive_error_count: i64,
    selection_penalty: i64,
    last_provider_guard_applied: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProviderQuotaManager {
    states: HashMap<String, ProviderQuotaInternalState>,
}

impl ProviderQuotaManager {
    pub(crate) fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    pub(crate) fn register_providers(&mut self, provider_keys: &[String]) {
        for key in provider_keys {
            let canonical = canonicalize_provider_key(key);
            self.states
                .entry(canonical.clone())
                .or_insert_with(|| ProviderQuotaInternalState {
                    provider_key: canonical,
                    in_pool: true,
                    reason: "active".to_string(),
                    auth_type: "unknown".to_string(),
                    auth_issue: None,
                    priority_tier: 100,
                    cooldown_until: None,
                    cooldown_keeps_pool: None,
                    blacklist_until: None,
                    reset_at: None,
                    last_error_series: None,
                    last_error_code: None,
                    last_error_at_ms: None,
                    consecutive_error_count: 0,
                    selection_penalty: 0,
                    last_provider_guard_applied: false,
                });
        }
    }

    pub(crate) fn register_provider_profile(&mut self, profile: &ProviderProfile) {
        let state = self.get_state_mut(&profile.provider_key);
        state.auth_type = read_auth_type(profile);
        state.priority_tier = read_priority_tier(profile);
    }

    pub(crate) fn record_success(&mut self, provider_key: &str) {
        let state = self.get_state_mut(provider_key);
        state.in_pool = true;
        state.reason = "active".to_string();
        state.auth_issue = None;
        state.cooldown_until = None;
        state.cooldown_keeps_pool = None;
        state.blacklist_until = None;
        state.reset_at = None;
        state.last_error_series = None;
        state.last_error_code = None;
        state.last_error_at_ms = None;
        state.consecutive_error_count = 0;
        state.selection_penalty = 0;
        state.last_provider_guard_applied = false;
    }

    pub(crate) fn reset_provider(&mut self, provider_key: &str) {
        self.record_success(provider_key);
    }

    pub(crate) fn recover_provider(&mut self, provider_key: &str) {
        self.record_success(provider_key);
    }

    pub(crate) fn disable_provider(&mut self, provider_key: &str, mode: &str, duration_ms: i64, now_ms: i64) {
        let state = self.get_state_mut(provider_key);
        let clamped_duration_ms = duration_ms.max(0);
        let until = if clamped_duration_ms > 0 {
            Some(now_ms.saturating_add(clamped_duration_ms))
        } else {
            None
        };
        state.in_pool = false;
        state.last_error_at_ms = Some(now_ms);
        state.consecutive_error_count = state.consecutive_error_count.max(1);
        state.selection_penalty = state.consecutive_error_count.max(1);
        state.last_provider_guard_applied = false;
        if mode.eq_ignore_ascii_case("blacklist") {
            state.reason = "blacklist".to_string();
            state.blacklist_until = until;
            state.cooldown_until = None;
            state.cooldown_keeps_pool = Some(false);
            state.reset_at = None;
            state.last_error_series = Some("EFATAL".to_string());
            state.last_error_code = Some("OPERATOR_BLACKLIST".to_string());
            return;
        }
        state.reason = "cooldown".to_string();
        state.cooldown_until = until;
        state.cooldown_keeps_pool = Some(false);
        state.blacklist_until = None;
        state.reset_at = None;
        state.last_error_series = Some("EOTHER".to_string());
        state.last_error_code = Some("OPERATOR_COOLDOWN".to_string());
    }

    pub(crate) fn record_error_signal(&mut self, provider_key: &str, now_ms: i64) {
        let state = self.get_state_mut(provider_key);
        state.last_error_at_ms = Some(now_ms);
        state.consecutive_error_count = (state.consecutive_error_count + 1).max(1);
        state.selection_penalty = state.consecutive_error_count.max(0);
        if state.reason.trim().is_empty() {
            state.reason = "active".to_string();
        }
    }

    pub(crate) fn get_state(&self, provider_key: &str) -> Option<ProviderQuotaState> {
        let canonical = canonicalize_provider_key(provider_key);
        let state = self.states.get(&canonical)?;
        Some(ProviderQuotaState {
            provider_key: state.provider_key.clone(),
            in_pool: state.in_pool,
            reason: state.reason.clone(),
            cooldown_until: state.cooldown_until,
            blacklist_until: state.blacklist_until,
            reset_at: state.reset_at,
            last_error_at_ms: state.last_error_at_ms,
            consecutive_error_count: state.consecutive_error_count,
        })
    }

    pub(crate) fn host_snapshot(&self) -> Vec<ProviderQuotaHostSnapshotEntry> {
        self.states
            .values()
            .map(|state| ProviderQuotaHostSnapshotEntry {
                provider_key: state.provider_key.clone(),
                in_pool: state.in_pool,
                reason: state.reason.clone(),
                auth_type: state.auth_type.clone(),
                auth_issue: state.auth_issue.clone(),
                priority_tier: state.priority_tier,
                cooldown_until: state.cooldown_until,
                cooldown_keeps_pool: state.cooldown_keeps_pool,
                blacklist_until: state.blacklist_until,
                reset_at: state.reset_at,
                last_error_series: state.last_error_series.clone(),
                last_error_code: state.last_error_code.clone(),
                last_error_at_ms: state.last_error_at_ms,
                consecutive_error_count: state.consecutive_error_count,
                selection_penalty: state.selection_penalty,
                last_provider_guard_applied: state.last_provider_guard_applied,
            })
            .collect()
    }

    pub(crate) fn freeze_quota_depleted(
        &mut self,
        provider_key: &str,
        now_ms: i64,
        cooldown_until: Option<i64>,
        reset_at: Option<i64>,
    ) {
        let state = self.get_state_mut(provider_key);
        state.in_pool = false;
        state.reason = "quotaDepleted".to_string();
        state.cooldown_until = cooldown_until;
        state.cooldown_keeps_pool = Some(false);
        state.blacklist_until = None;
        state.reset_at = reset_at;
        state.last_error_series = Some("E429".to_string());
        state.last_error_code = Some("QUOTA_DEPLETED".to_string());
        state.last_error_at_ms = Some(now_ms);
        state.consecutive_error_count = (state.consecutive_error_count + 1).max(1);
        state.selection_penalty = state.consecutive_error_count.max(0);
        state.last_provider_guard_applied = false;
    }

    pub(crate) fn apply_http_402_resetat_cooldown(
        &mut self,
        provider_key: &str,
        now_ms: i64,
        cooldown_until: i64,
        last_error_code: &str,
    ) {
        let state = self.get_state_mut(provider_key);
        state.in_pool = true;
        state.reason = "cooldown".to_string();
        state.cooldown_until = Some(cooldown_until);
        state.cooldown_keeps_pool = Some(true);
        state.blacklist_until = None;
        state.reset_at = None;
        state.last_error_series = Some("EOTHER".to_string());
        state.last_error_code = Some(last_error_code.trim().to_string());
        state.last_error_at_ms = Some(now_ms);
        state.consecutive_error_count = 0;
        state.selection_penalty = 0;
        state.last_provider_guard_applied = false;
    }

    pub(crate) fn snapshot(&self) -> Vec<ProviderQuotaState> {
        self.states
            .values()
            .map(|state| ProviderQuotaState {
                provider_key: state.provider_key.clone(),
                in_pool: state.in_pool,
                reason: state.reason.clone(),
                cooldown_until: state.cooldown_until,
                blacklist_until: state.blacklist_until,
                reset_at: state.reset_at,
                last_error_at_ms: state.last_error_at_ms,
                consecutive_error_count: state.consecutive_error_count,
            })
            .collect()
    }

    pub(crate) fn active_blocker(&self, provider_key: &str, now_ms: i64) -> Option<ProviderQuotaState> {
        let canonical = canonicalize_provider_key(provider_key);
        let state = self.states.get(&canonical)?;
        let blacklist_until = state.blacklist_until.filter(|until| *until > now_ms);
        let reset_at = state.reset_at.filter(|until| *until > now_ms);
        let cooldown_until = state.cooldown_until.filter(|until| *until > now_ms);
        let has_active_blocker = blacklist_until.is_some()
            || reset_at.is_some()
            || cooldown_until.is_some()
            || (!state.in_pool && state.reason != "active");
        if !has_active_blocker {
            return None;
        }
        Some(ProviderQuotaState {
            provider_key: state.provider_key.clone(),
            in_pool: state.in_pool,
            reason: state.reason.clone(),
            cooldown_until,
            blacklist_until,
            reset_at,
            last_error_at_ms: state.last_error_at_ms,
            consecutive_error_count: state.consecutive_error_count,
        })
    }

    fn get_state_mut(&mut self, provider_key: &str) -> &mut ProviderQuotaInternalState {
        let canonical = canonicalize_provider_key(provider_key);
        self.states
            .entry(canonical.clone())
            .or_insert_with(|| ProviderQuotaInternalState {
                provider_key: canonical,
                in_pool: true,
                reason: "active".to_string(),
                auth_type: "unknown".to_string(),
                auth_issue: None,
                priority_tier: 100,
                cooldown_until: None,
                cooldown_keeps_pool: None,
                blacklist_until: None,
                reset_at: None,
                last_error_series: None,
                last_error_code: None,
                last_error_at_ms: None,
                consecutive_error_count: 0,
                selection_penalty: 0,
                last_provider_guard_applied: false,
            })
    }
}

fn read_auth_type(profile: &ProviderProfile) -> String {
    if let Some(raw) = profile
        .provider_specific_config
        .get("authType")
        .and_then(|value| value.as_str())
    {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized == "apikey" || normalized == "oauth" || normalized == "unknown" {
            return normalized;
        }
    }
    if let Some(kind) = profile
        .provider_specific_config
        .get("auth")
        .and_then(|value| value.get("type"))
        .and_then(|value| value.as_str())
    {
        let normalized = kind.trim().to_ascii_lowercase();
        if normalized == "apikey" || normalized == "api_key" || normalized == "apiKey".to_ascii_lowercase() {
            return "apikey".to_string();
        }
        if normalized == "oauth" {
            return "oauth".to_string();
        }
    }
    "unknown".to_string()
}

fn read_priority_tier(profile: &ProviderProfile) -> i64 {
    profile
        .provider_specific_config
        .get("priorityTier")
        .and_then(|value| value.as_i64())
        .unwrap_or(100)
}

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
