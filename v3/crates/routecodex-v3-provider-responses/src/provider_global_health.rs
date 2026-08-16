use routecodex_v3_error::{V3ProviderErrorFingerprint, V3ProviderFailureSessionScope};
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

const DEFAULT_FAILURE_THRESHOLD: u32 = 3;
const DEFAULT_GLOBAL_COOLDOWN_MS: u64 = 60 * 60_000;
const DEFAULT_PROBE_INTERVAL_MS: u64 = 60 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderGlobalSubscriptionPolicy {
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
    pub probe_interval_ms: u64,
}

impl Default for V3ProviderGlobalSubscriptionPolicy {
    fn default() -> Self {
        Self {
            failure_threshold: DEFAULT_FAILURE_THRESHOLD,
            cooldown_ms: DEFAULT_GLOBAL_COOLDOWN_MS,
            probe_interval_ms: DEFAULT_PROBE_INTERVAL_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ProviderGlobalSubscriptionDecision {
    SessionFailure { count: u32 },
    ProviderBlocked { blocked_until_ms: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderGlobalProbePermit {
    provider: V3ProviderGlobalKey,
    provider_key: String,
    started_at_ms: u64,
    probe_interval_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderGlobalAvailability {
    pub provider_key: String,
    pub available: bool,
    pub blocked_until_ms: Option<u64>,
    pub probe_in_flight: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ProviderGlobalKey {
    provider_id: String,
    auth_alias: Option<String>,
    model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ProviderSessionFingerprintKey {
    provider: V3ProviderGlobalKey,
    server_id: String,
    routing_group: String,
    session_id: String,
    fingerprint: V3ProviderErrorFingerprint,
}

#[derive(Debug, Clone)]
struct V3ProviderGlobalState {
    probe_auth_alias: Option<String>,
    probe_model_id: Option<String>,
    blocked_until_ms: Option<u64>,
    next_probe_at_ms: Option<u64>,
    probe_in_flight: bool,
    probe_interval_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct V3ProviderGlobalHealthState {
    failures: BTreeMap<V3ProviderSessionFingerprintKey, u32>,
    providers: BTreeMap<V3ProviderGlobalKey, V3ProviderGlobalState>,
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderGlobalSubscriptionHealthStore {
    state: Arc<RwLock<V3ProviderGlobalHealthState>>,
}

impl V3ProviderGlobalSubscriptionHealthStore {
    pub fn record_invalid_subscription_response(
        &self,
        session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        fingerprint: V3ProviderErrorFingerprint,
        now_ms: u64,
        policy: &V3ProviderGlobalSubscriptionPolicy,
    ) -> Result<V3ProviderGlobalSubscriptionDecision, String> {
        if policy.failure_threshold == 0 || policy.cooldown_ms == 0 || policy.probe_interval_ms == 0
        {
            return Err("provider global subscription policy values must be non-zero".to_string());
        }
        let provider = global_key(provider_id, auth_alias, model_id);
        let key = V3ProviderSessionFingerprintKey {
            provider: provider.clone(),
            server_id: session_scope.server_id().to_string(),
            routing_group: session_scope.routing_group().to_string(),
            session_id: session_scope.session_id().to_string(),
            fingerprint,
        };
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        let count = state.failures.entry(key).or_insert(0);
        *count = count.saturating_add(1);
        if *count < policy.failure_threshold {
            return Ok(V3ProviderGlobalSubscriptionDecision::SessionFailure { count: *count });
        }
        let blocked_until_ms = now_ms.saturating_add(policy.cooldown_ms);
        state.providers.insert(
            provider,
            V3ProviderGlobalState {
                probe_auth_alias: auth_alias.map(str::to_string),
                probe_model_id: model_id.map(str::to_string),
                blocked_until_ms: Some(blocked_until_ms),
                next_probe_at_ms: Some(now_ms.saturating_add(policy.probe_interval_ms)),
                probe_in_flight: false,
                probe_interval_ms: policy.probe_interval_ms,
            },
        );
        Ok(V3ProviderGlobalSubscriptionDecision::ProviderBlocked { blocked_until_ms })
    }

    pub fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderGlobalAvailability, String> {
        let provider = global_key(provider_id, auth_alias, model_id);
        let state = self
            .state
            .read()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        let provider_state = state.providers.get(&provider);
        let blocked = provider_state.is_some_and(|value| {
            value.probe_in_flight
                || value.next_probe_at_ms.is_some()
                || value
                    .blocked_until_ms
                    .is_some_and(|blocked_until_ms| blocked_until_ms > now_ms)
        });
        Ok(V3ProviderGlobalAvailability {
            provider_key: provider_label(&provider),
            available: !blocked,
            blocked_until_ms: provider_state.and_then(|value| {
                value
                    .blocked_until_ms
                    .filter(|blocked_until_ms| *blocked_until_ms > now_ms)
            }),
            probe_in_flight: provider_state.is_some_and(|value| value.probe_in_flight),
        })
    }

    pub fn try_acquire_probe(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<Option<V3ProviderGlobalProbePermit>, String> {
        let provider = global_key(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        let Some(provider_state) = state.providers.get_mut(&provider) else {
            return Ok(None);
        };
        if provider_state.probe_in_flight
            || provider_state.blocked_until_ms.is_none()
            || provider_state
                .next_probe_at_ms
                .is_none_or(|next_probe_at_ms| next_probe_at_ms > now_ms)
        {
            return Ok(None);
        }
        provider_state.probe_in_flight = true;
        let provider_key = provider_label(&provider);
        let probe_interval_ms = provider_state.probe_interval_ms.max(1);
        Ok(Some(V3ProviderGlobalProbePermit {
            provider,
            provider_key,
            started_at_ms: now_ms,
            probe_interval_ms,
        }))
    }

    pub fn provider_keys_with_probe_due(
        &self,
        now_ms: u64,
    ) -> Result<Vec<(String, Option<String>, Option<String>)>, String> {
        let state = self
            .state
            .read()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        Ok(state
            .providers
            .iter()
            .filter(|(_, provider_state)| {
                !provider_state.probe_in_flight
                    && provider_state.blocked_until_ms.is_some()
                    && provider_state
                        .next_probe_at_ms
                        .is_some_and(|next_probe_at_ms| next_probe_at_ms <= now_ms)
            })
            .map(|(provider, provider_state)| {
                (
                    provider.provider_id.clone(),
                    provider_state.probe_auth_alias.clone(),
                    provider_state.probe_model_id.clone(),
                )
            })
            .collect())
    }

    pub fn complete_probe_success(
        &self,
        permit: V3ProviderGlobalProbePermit,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        let provider = permit.provider;
        let provider_state = state
            .providers
            .get_mut(&provider)
            .ok_or_else(|| "provider global probe state missing".to_string())?;
        if !provider_state.probe_in_flight {
            return Err("provider global probe is not in flight".to_string());
        }
        provider_state.probe_in_flight = false;
        provider_state.blocked_until_ms = None;
        provider_state.next_probe_at_ms = None;
        state.failures.retain(|key, _| key.provider != provider);
        state.providers.remove(&provider);
        Ok(())
    }

    pub fn complete_probe_failure(
        &self,
        permit: V3ProviderGlobalProbePermit,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        let provider = permit.provider;
        let provider_state = state
            .providers
            .get_mut(&provider)
            .ok_or_else(|| "provider global probe state missing".to_string())?;
        if !provider_state.probe_in_flight {
            return Err("provider global probe is not in flight".to_string());
        }
        provider_state.probe_in_flight = false;
        // 订阅类故障通常数小时后由上游恢复：失败后不 suspend-until-restart，
        // 按 probe interval 排下一次探针，探针通过才拉回路由池。
        provider_state.next_probe_at_ms = Some(
            permit
                .started_at_ms
                .saturating_add(permit.probe_interval_ms),
        );
        Ok(())
    }

    pub fn reset_after_restart(&self) -> Result<(), String> {
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        state.failures.clear();
        state.providers.clear();
        Ok(())
    }

    pub fn record_provider_success(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        session_scope: &V3ProviderFailureSessionScope,
    ) -> Result<(), String> {
        let provider = global_key(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider global health lock poisoned: {error}"))?;
        state.failures.retain(|key, _| {
            !(key.provider == provider
                && key.server_id == session_scope.server_id()
                && key.routing_group == session_scope.routing_group()
                && key.session_id == session_scope.session_id())
        });
        Ok(())
    }
}

fn global_key(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3ProviderGlobalKey {
    V3ProviderGlobalKey {
        provider_id: provider_id.to_string(),
        auth_alias: auth_alias.map(str::to_string),
        model_id: model_id.map(str::to_string),
    }
}

fn provider_label(provider: &V3ProviderGlobalKey) -> String {
    format!(
        "{}:{}:{}",
        provider.provider_id,
        provider.auth_alias.as_deref().unwrap_or("-"),
        provider.model_id.as_deref().unwrap_or("-")
    )
}
