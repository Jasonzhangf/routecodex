use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{V3ErrorActionScope, V3ProviderFailureSessionScope};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderAvailabilityProjection {
    pub provider_id: String,
    pub auth_alias: Option<String>,
    pub model_id: Option<String>,
    pub available: bool,
    pub blocked_scopes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderQuotaState {
    pub scope_label: String,
    pub remaining: u64,
    pub reset_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderConcurrencyState {
    pub provider_id: String,
    pub in_flight: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailurePolicy {
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
}

impl Default for V3ProviderFailurePolicy {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
            cooldown_ms: 15 * 60_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailureRecord {
    pub scope_label: String,
    pub provider_key: String,
    pub state: String,
    pub failure_count: u32,
    pub cooldown_until_ms: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderCrossSessionReviveAdmission {
    pub provider_key: String,
    pub original_cooldown_until_ms: u64,
    pub evidence_session_id: String,
}

pub trait V3ProviderAvailabilityReader {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection;
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderAllAvailable;

impl V3ProviderAvailabilityReader for V3ProviderAllAvailable {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        V3ProviderAvailabilityProjection {
            provider_id: provider_id.to_string(),
            auth_alias: auth_alias.map(ToOwned::to_owned),
            model_id: model_id.map(ToOwned::to_owned),
            available: true,
            blocked_scopes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderHealthStore {
    state: Arc<RwLock<V3ProviderHealthState>>,
}

#[derive(Debug, Clone)]
pub struct V3ProviderAvailabilityRegistry {
    store: V3ProviderHealthStore,
}

#[derive(Debug, Clone)]
pub struct V3ProviderSessionAvailabilityReader {
    store: V3ProviderHealthStore,
    failure_session_scope: V3ProviderFailureSessionScope,
}

impl V3ProviderSessionAvailabilityReader {
    pub fn new(
        store: V3ProviderHealthStore,
        failure_session_scope: V3ProviderFailureSessionScope,
    ) -> Self {
        Self {
            store,
            failure_session_scope,
        }
    }
}

impl V3ProviderAvailabilityReader for V3ProviderSessionAvailabilityReader {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.store.availability_for_session(
            &self.failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            now_ms,
        )
    }
}

impl V3ProviderAvailabilityRegistry {
    pub fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest(manifest),
        }
    }

    pub fn from_store(store: V3ProviderHealthStore) -> Self {
        Self { store }
    }
}

impl V3ProviderAvailabilityReader for V3ProviderAvailabilityRegistry {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.store
            .availability(provider_id, auth_alias, model_id, now_ms)
    }
}

#[derive(Debug, Default)]
struct V3ProviderHealthState {
    configured_disabled: BTreeSet<String>,
    health_disabled: BTreeSet<String>,
    failure_policies: BTreeMap<String, V3ProviderFailurePolicy>,
    consecutive_failures: BTreeMap<V3ProviderFailureSessionKey, V3ProviderConsecutiveFailure>,
    cooldowns: BTreeMap<V3ProviderFailureSessionKey, V3ProviderCooldown>,
    session_successes: BTreeMap<V3ProviderFailureSessionKey, u64>,
    quotas: BTreeMap<String, V3ProviderQuotaState>,
    concurrency: BTreeMap<String, V3ProviderConcurrencyState>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ProviderFailureSessionKey {
    server_id: String,
    routing_group: String,
    session_id: String,
    provider_runtime_identity: String,
}

#[derive(Debug, Clone)]
struct V3ProviderCooldown {
    reason: String,
    until_ms: Option<u64>,
    revive_consumed_for_until_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct V3ProviderConsecutiveFailure {
    failure_count: u32,
    last_failure_at_ms: u64,
    reason: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum V3ProviderHealthError {
    #[error("provider health state lock poisoned: {0}")]
    Poisoned(String),
}

impl V3ProviderHealthStore {
    pub fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        let configured_disabled = manifest
            .providers
            .values()
            .filter(|provider| !provider.enabled)
            .map(|provider| provider.id.clone())
            .collect();
        let mut health_disabled = BTreeSet::new();
        let mut failure_policies = BTreeMap::new();
        for provider in manifest.providers.values() {
            match provider.health.as_ref() {
                Some(health) if !health.enabled => {
                    health_disabled.insert(provider.id.clone());
                }
                Some(health) => {
                    failure_policies.insert(
                        provider.id.clone(),
                        V3ProviderFailurePolicy {
                            failure_threshold: health.failure_threshold.max(1),
                            cooldown_ms: health.cooldown_ms.max(1),
                        },
                    );
                }
                None => {
                    failure_policies
                        .insert(provider.id.clone(), V3ProviderFailurePolicy::default());
                }
            }
        }
        Self {
            state: Arc::new(RwLock::new(V3ProviderHealthState {
                configured_disabled,
                health_disabled,
                failure_policies,
                ..V3ProviderHealthState::default()
            })),
        }
    }

    pub fn record_provider_failure_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        let provider_key = provider_key_label(provider_id, auth_alias, model_id);
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
        let scope_label = provider_failure_session_scope_label(&key);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if state.health_disabled.contains(provider_id) {
            return Ok(V3ProviderFailureRecord {
                scope_label,
                provider_key,
                state: "health_disabled".to_string(),
                failure_count: 0,
                cooldown_until_ms: None,
                reason: reason.map(str::to_string),
            });
        }
        if state
            .cooldowns
            .get(&key)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until > now_ms))
        {
            let failure_count = state
                .consecutive_failures
                .get(&key)
                .map_or(0, |failure| failure.failure_count);
            let cooldown_until_ms = state
                .cooldowns
                .get(&key)
                .and_then(|cooldown| cooldown.until_ms);
            return Ok(V3ProviderFailureRecord {
                scope_label,
                provider_key,
                state: "cooldown".to_string(),
                failure_count,
                cooldown_until_ms,
                reason: reason.map(str::to_string),
            });
        }
        if state
            .cooldowns
            .get(&key)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until <= now_ms))
        {
            state.cooldowns.remove(&key);
            state.consecutive_failures.remove(&key);
        }
        let policy = state
            .failure_policies
            .get(provider_id)
            .copied()
            .unwrap_or_default();
        let failure =
            state
                .consecutive_failures
                .entry(key.clone())
                .or_insert(V3ProviderConsecutiveFailure {
                    failure_count: 0,
                    last_failure_at_ms: now_ms,
                    reason: None,
                });
        failure.failure_count = failure.failure_count.saturating_add(1);
        failure.last_failure_at_ms = now_ms;
        if let Some(reason) = reason.filter(|value| !value.trim().is_empty()) {
            failure.reason = Some(reason.to_string());
        }
        let failure_count = failure.failure_count;
        let record_reason = failure.reason.clone();
        let mut cooldown_until_ms = None;
        let mut record_state = "healthy".to_string();
        if failure_count >= policy.failure_threshold {
            cooldown_until_ms = Some(now_ms.saturating_add(policy.cooldown_ms));
            record_state = "cooldown".to_string();
            state.cooldowns.insert(
                key,
                V3ProviderCooldown {
                    reason: record_reason
                        .clone()
                        .unwrap_or_else(|| "provider_consecutive_failures".to_string()),
                    until_ms: cooldown_until_ms,
                    revive_consumed_for_until_ms: None,
                },
            );
        }
        Ok(V3ProviderFailureRecord {
            scope_label,
            provider_key,
            state: record_state,
            failure_count,
            cooldown_until_ms,
            reason: record_reason,
        })
    }

    pub fn record_provider_success_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        state.cooldowns.remove(&key);
        state.consecutive_failures.remove(&key);
        state.session_successes.insert(key, now_ms);
        Ok(())
    }

    pub fn record_provider_revive_success_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        state.cooldowns.remove(&key);
        state.consecutive_failures.remove(&key);
        state.session_successes.insert(key, now_ms);
        remove_expired_session_state(&mut state, now_ms);
        Ok(())
    }

    pub fn try_acquire_cross_session_revive(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<Option<V3ProviderCrossSessionReviveAdmission>, V3ProviderHealthError> {
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        remove_expired_session_state(&mut state, now_ms);
        let original_cooldown_until_ms = match state.cooldowns.get(&key) {
            Some(cooldown) => match cooldown.until_ms {
                Some(until_ms) if until_ms > now_ms => until_ms,
                _ => return Ok(None),
            },
            None => return Ok(None),
        };
        if state.cooldowns.get(&key).is_some_and(|cooldown| {
            cooldown.revive_consumed_for_until_ms == Some(original_cooldown_until_ms)
        }) {
            return Ok(None);
        }
        let evidence_session_id = state
            .session_successes
            .iter()
            .filter(|(candidate, _)| {
                candidate.server_id == key.server_id
                    && candidate.routing_group == key.routing_group
                    && candidate.provider_runtime_identity == key.provider_runtime_identity
                    && candidate.session_id != key.session_id
                    && !state.cooldowns.get(*candidate).is_some_and(|cooldown| {
                        cooldown.until_ms.is_none_or(|until_ms| until_ms > now_ms)
                    })
            })
            .max_by_key(|(_, success_at_ms)| *success_at_ms)
            .map(|(candidate, _)| candidate.session_id.clone());
        let Some(evidence_session_id) = evidence_session_id else {
            return Ok(None);
        };
        state
            .cooldowns
            .get_mut(&key)
            .expect("active cooldown was validated under the same write lock")
            .revive_consumed_for_until_ms = Some(original_cooldown_until_ms);
        Ok(Some(V3ProviderCrossSessionReviveAdmission {
            provider_key: provider_key_label(provider_id, auth_alias, model_id),
            original_cooldown_until_ms,
            evidence_session_id,
        }))
    }

    pub(crate) fn update_quota_state(
        &self,
        scope: &V3ErrorActionScope,
        remaining: u64,
        reset_at_ms: Option<u64>,
    ) -> Result<V3ProviderQuotaState, V3ProviderHealthError> {
        let quota = V3ProviderQuotaState {
            scope_label: scope_label(scope),
            remaining,
            reset_at_ms,
        };
        self.state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?
            .quotas
            .insert(quota.scope_label.clone(), quota.clone());
        Ok(quota)
    }

    pub(crate) fn update_concurrency_state(
        &self,
        provider_id: impl Into<String>,
        in_flight: u32,
        limit: u32,
    ) -> Result<V3ProviderConcurrencyState, V3ProviderHealthError> {
        let provider_id = provider_id.into();
        let concurrency = V3ProviderConcurrencyState {
            provider_id: provider_id.clone(),
            in_flight,
            limit,
        };
        self.state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?
            .concurrency
            .insert(provider_id, concurrency.clone());
        Ok(concurrency)
    }

    pub fn availability_for_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .expect("provider health lock should not be poisoned in session projection");
        remove_expired_session_state(&mut state, now_ms);
        let mut projection =
            global_availability_projection(&state, provider_id, auth_alias, model_id, now_ms);
        if let Some(cooldown) = state
            .cooldowns
            .get(&key)
            .filter(|cooldown| cooldown.until_ms.is_none_or(|until_ms| until_ms > now_ms))
        {
            projection.blocked_scopes.push(format!(
                "{}:{}",
                provider_failure_session_scope_label(&key),
                cooldown.reason
            ));
            projection.available = false;
        }
        projection
    }
}

impl V3ProviderAvailabilityReader for V3ProviderHealthStore {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let state = self
            .state
            .read()
            .expect("provider health lock should not be poisoned in projection");
        global_availability_projection(&state, provider_id, auth_alias, model_id, now_ms)
    }
}

pub(crate) fn explain_provider_health_reasons(
    store: &V3ProviderHealthStore,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> Vec<String> {
    let keys = availability_scope_keys(provider_id, auth_alias, model_id);
    let state = store
        .state
        .read()
        .expect("provider health lock should not be poisoned in diagnostic projection");
    state
        .quotas
        .values()
        .filter(|quota| {
            keys.contains(&quota.scope_label)
                && quota.remaining == 0
                && quota
                    .reset_at_ms
                    .is_none_or(|reset_at_ms| reset_at_ms > now_ms)
        })
        .map(|quota| format!("quota:{}:exhausted", quota.scope_label))
        .chain(
            state
                .concurrency
                .get(provider_id)
                .filter(|concurrency| {
                    concurrency.limit > 0 && concurrency.in_flight >= concurrency.limit
                })
                .map(|concurrency| {
                    format!(
                        "concurrency:provider_instance:{}:{}/{}",
                        provider_id, concurrency.in_flight, concurrency.limit
                    )
                }),
        )
        .collect()
}

fn global_availability_projection(
    state: &V3ProviderHealthState,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> V3ProviderAvailabilityProjection {
    let keys = availability_scope_keys(provider_id, auth_alias, model_id);
    let mut blocked_scopes = Vec::new();
    if state.configured_disabled.contains(provider_id) {
        blocked_scopes.push(format!(
            "configured_disabled:provider_instance:{provider_id}"
        ));
    }
    if state.health_disabled.contains(provider_id) {
        blocked_scopes.push(format!("health_disabled:provider_instance:{provider_id}"));
    }
    blocked_scopes.extend(
        keys.iter()
            .filter(|key| {
                state.quotas.get(*key).is_some_and(|quota| {
                    quota.remaining == 0
                        && quota
                            .reset_at_ms
                            .is_none_or(|reset_at_ms| reset_at_ms > now_ms)
                })
            })
            .map(|key| format!("quota:{key}")),
    );
    if state
        .concurrency
        .get(provider_id)
        .is_some_and(|concurrency| {
            concurrency.limit > 0 && concurrency.in_flight >= concurrency.limit
        })
    {
        blocked_scopes.push(format!("concurrency:provider_instance:{provider_id}"));
    }
    V3ProviderAvailabilityProjection {
        provider_id: provider_id.to_string(),
        auth_alias: auth_alias.map(ToOwned::to_owned),
        model_id: model_id.map(ToOwned::to_owned),
        available: blocked_scopes.is_empty(),
        blocked_scopes,
    }
}

fn provider_failure_session_key(
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3ProviderFailureSessionKey {
    V3ProviderFailureSessionKey {
        server_id: failure_session_scope.server_id().to_string(),
        routing_group: failure_session_scope.routing_group().to_string(),
        session_id: failure_session_scope.session_id().to_string(),
        provider_runtime_identity: provider_key_label(provider_id, auth_alias, model_id),
    }
}

fn provider_failure_session_scope_label(key: &V3ProviderFailureSessionKey) -> String {
    format!(
        "provider_failure_session:{}:{}:{}:{}",
        key.server_id, key.routing_group, key.session_id, key.provider_runtime_identity
    )
}

fn remove_expired_session_state(state: &mut V3ProviderHealthState, now_ms: u64) {
    const SESSION_STATE_IDLE_TTL_MS: u64 = 30 * 60_000;
    state
        .cooldowns
        .retain(|_, cooldown| cooldown.until_ms.is_none_or(|until_ms| until_ms > now_ms));
    state.consecutive_failures.retain(|key, failure| {
        state.cooldowns.contains_key(key)
            || failure
                .last_failure_at_ms
                .saturating_add(SESSION_STATE_IDLE_TTL_MS)
                > now_ms
    });
    state.session_successes.retain(|_, success_at_ms| {
        success_at_ms.saturating_add(SESSION_STATE_IDLE_TTL_MS) > now_ms
    });
}

fn availability_scope_keys(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> Vec<String> {
    let mut keys = vec![format!("provider_instance:{provider_id}")];
    if let Some(auth_alias) = auth_alias {
        keys.push(format!("auth_key:{provider_id}:{auth_alias}"));
    }
    if let Some(model_id) = model_id {
        keys.push(format!("canonical_model:{provider_id}:{model_id}"));
    }
    if auth_alias.is_some() || model_id.is_some() {
        keys.push(provider_key_scope_label(provider_id, auth_alias, model_id));
    }
    keys
}

fn provider_key_scope_label(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "provider_key:{}",
        provider_key_label(provider_id, auth_alias, model_id)
    )
}

fn provider_key_label(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or("-"),
        model_id.unwrap_or("-")
    )
}

fn scope_label(scope: &V3ErrorActionScope) -> String {
    match scope {
        V3ErrorActionScope::None => "none".to_string(),
        V3ErrorActionScope::ProviderInstance { provider_id } => {
            format!("provider_instance:{provider_id}")
        }
        V3ErrorActionScope::AuthKey {
            provider_id,
            auth_alias,
        } => format!("auth_key:{provider_id}:{auth_alias}"),
        V3ErrorActionScope::CanonicalModel {
            provider_id,
            model_id,
        } => format!("canonical_model:{provider_id}:{model_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

    fn session(session_id: &str) -> V3ProviderFailureSessionScope {
        V3ProviderFailureSessionScope::new("server-a", "group-a", session_id).unwrap()
    }

    #[test]
    fn manifest_disabled_provider_is_projected_as_unavailable_by_provider_owner() {
        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.disabled]
enabled = false
type = "responses"
base_url = "http://disabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.disabled.models.m]
[providers.enabled]
type = "responses"
base_url = "http://enabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.enabled.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "enabled", model = "m", key = "k", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();
        let availability = V3ProviderAvailabilityRegistry::from_manifest(&manifest);
        assert!(
            !availability
                .availability("disabled", Some("k"), Some("m"), 0)
                .available
        );
        assert!(
            availability
                .availability("enabled", Some("k"), Some("m"), 0)
                .available
        );
    }

    #[test]
    fn three_failures_cool_only_the_originating_session() {
        let store = V3ProviderHealthStore::default();
        for now_ms in 100..103 {
            store
                .record_provider_failure_in_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    Some("controlled failure"),
                    now_ms,
                )
                .unwrap();
        }
        assert!(
            !store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    103,
                )
                .available
        );
        assert!(
            store
                .availability_for_session(
                    &session("session-b"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    103,
                )
                .available
        );
    }

    #[test]
    fn failures_from_different_sessions_never_combine() {
        let store = V3ProviderHealthStore::default();
        for session_id in ["session-a", "session-b", "session-b"] {
            store
                .record_provider_failure_in_session(
                    &session(session_id),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    None,
                    100,
                )
                .unwrap();
        }
        for session_id in ["session-a", "session-b"] {
            assert!(
                store
                    .availability_for_session(
                        &session(session_id),
                        "provider-a",
                        Some("key-a"),
                        Some("gpt-5.5"),
                        101,
                    )
                    .available
            );
        }
    }

    #[test]
    fn cross_session_revive_is_atomic_and_preserves_original_deadline_on_failure() {
        let store = V3ProviderHealthStore::default();
        store
            .record_provider_success_in_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                90,
            )
            .unwrap();
        let mut original_deadline = None;
        for now_ms in 100..103 {
            original_deadline = store
                .record_provider_failure_in_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    None,
                    now_ms,
                )
                .unwrap()
                .cooldown_until_ms;
        }
        let admission = store
            .try_acquire_cross_session_revive(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                103,
            )
            .unwrap()
            .expect("healthy sibling evidence grants one revive");
        assert_eq!(
            Some(admission.original_cooldown_until_ms),
            original_deadline
        );
        assert!(store
            .try_acquire_cross_session_revive(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                104,
            )
            .unwrap()
            .is_none());
        let failed_revive = store
            .record_provider_failure_in_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("revive failed"),
                105,
            )
            .unwrap();
        assert_eq!(failed_revive.cooldown_until_ms, original_deadline);
    }

    #[test]
    fn quota_concurrency_and_diagnostics_are_provider_owned_inputs() {
        let store = V3ProviderHealthStore::default();
        store
            .update_quota_state(
                &V3ErrorActionScope::CanonicalModel {
                    provider_id: "provider-a".to_string(),
                    model_id: "gpt-5.5".to_string(),
                },
                0,
                Some(1_000),
            )
            .unwrap();
        assert!(
            !store
                .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("provider-a", Some("key-a"), Some("other-model"), 101)
                .available
        );
        store.update_concurrency_state("provider-b", 2, 2).unwrap();
        assert!(
            !store
                .availability("provider-b", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("third", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert_eq!(
            explain_provider_health_reasons(
                &store,
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                101,
            ),
            vec!["quota:canonical_model:provider-a:gpt-5.5:exhausted"]
        );
    }
}
