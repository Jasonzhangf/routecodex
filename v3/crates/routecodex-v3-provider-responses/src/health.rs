use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{V3ErrorActionPlan, V3ErrorActionScope};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderHealthActionApplied {
    pub scope_label: String,
    pub reason: String,
    pub until_ms: Option<u64>,
    pub health_affecting: bool,
}

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
    consecutive_failures: BTreeMap<String, V3ProviderConsecutiveFailure>,
    cooldowns: BTreeMap<String, V3ProviderCooldown>,
    quotas: BTreeMap<String, V3ProviderQuotaState>,
    concurrency: BTreeMap<String, V3ProviderConcurrencyState>,
}

#[derive(Debug, Clone)]
struct V3ProviderCooldown {
    reason: String,
    until_ms: Option<u64>,
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

    pub fn record_provider_failure(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        let scope_label = provider_key_scope_label(provider_id, auth_alias, model_id);
        let provider_key = provider_key_label(provider_id, auth_alias, model_id);
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
            .get(&scope_label)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until > now_ms))
        {
            let failure_count = state
                .consecutive_failures
                .get(&scope_label)
                .map_or(0, |failure| failure.failure_count);
            let cooldown_until_ms = state
                .cooldowns
                .get(&scope_label)
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
            .get(&scope_label)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until <= now_ms))
        {
            state.cooldowns.remove(&scope_label);
            state.consecutive_failures.remove(&scope_label);
        }
        let policy = state
            .failure_policies
            .get(provider_id)
            .copied()
            .unwrap_or_default();
        let failure = state
            .consecutive_failures
            .entry(scope_label.clone())
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
                scope_label.clone(),
                V3ProviderCooldown {
                    reason: record_reason
                        .clone()
                        .unwrap_or_else(|| "provider_consecutive_failures".to_string()),
                    until_ms: cooldown_until_ms,
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

    pub fn record_provider_success(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let scope_label = provider_key_scope_label(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if state
            .cooldowns
            .get(&scope_label)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until > now_ms))
        {
            return Ok(());
        }
        state.cooldowns.remove(&scope_label);
        state.consecutive_failures.remove(&scope_label);
        Ok(())
    }

    pub(crate) fn apply_error_action(
        &self,
        action: &V3ErrorActionPlan,
        now_ms: u64,
    ) -> Result<V3ProviderHealthActionApplied, V3ProviderHealthError> {
        let scope_label = scope_label(&action.scope);
        let until_ms = action
            .duration_ms
            .map(|duration| now_ms.saturating_add(duration));
        if action.health_affecting && !matches!(action.scope, V3ErrorActionScope::None) {
            self.state
                .write()
                .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?
                .cooldowns
                .insert(
                    scope_label.clone(),
                    V3ProviderCooldown {
                        reason: action.reason.clone(),
                        until_ms,
                    },
                );
        }
        Ok(V3ProviderHealthActionApplied {
            scope_label,
            reason: action.reason.clone(),
            until_ms,
            health_affecting: action.health_affecting,
        })
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
}

impl V3ProviderAvailabilityReader for V3ProviderHealthStore {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let keys = availability_scope_keys(provider_id, auth_alias, model_id);
        let state = self
            .state
            .read()
            .expect("provider health lock should not be poisoned in projection");
        let mut blocked_scopes =
            keys.iter()
                .filter(|key| {
                    state.cooldowns.get(*key).is_some_and(|cooldown| {
                        cooldown.until_ms.is_none_or(|until| until > now_ms)
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
        if state.configured_disabled.contains(provider_id) {
            blocked_scopes.push(format!(
                "configured_disabled:provider_instance:{provider_id}"
            ));
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
    keys.into_iter()
        .filter_map(|key| {
            state.cooldowns.get(&key).and_then(|cooldown| {
                cooldown
                    .until_ms
                    .is_none_or(|until| until > now_ms)
                    .then(|| format!("{key}:{}", cooldown.reason))
            })
        })
        .chain(
            state
                .quotas
                .values()
                .filter(|quota| {
                    quota.remaining == 0
                        && quota
                            .reset_at_ms
                            .is_none_or(|reset_at_ms| reset_at_ms > now_ms)
                })
                .map(|quota| format!("quota:{}:exhausted", quota.scope_label)),
        )
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

    fn action(scope: V3ErrorActionScope) -> V3ErrorActionPlan {
        V3ErrorActionPlan {
            scope,
            reason: "provider_failure".to_string(),
            duration_ms: Some(10_000),
            retry_eligible: true,
            health_affecting: true,
            exhaustion_effect: "target_local_reselect".to_string(),
        }
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
    fn health_actions_are_scoped_and_availability_projection_is_read_only() {
        let store = V3ProviderHealthStore::default();
        let applied = store
            .apply_error_action(
                &action(V3ErrorActionScope::AuthKey {
                    provider_id: "provider-a".to_string(),
                    auth_alias: "key-a".to_string(),
                }),
                100,
            )
            .unwrap();
        assert_eq!(applied.scope_label, "auth_key:provider-a:key-a");
        assert!(
            !store
                .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("provider-a", Some("key-b"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("provider-b", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
    }

    #[test]
    fn client_disconnect_or_none_scope_does_not_mutate_health() {
        let store = V3ProviderHealthStore::default();
        store
            .apply_error_action(
                &V3ErrorActionPlan {
                    scope: V3ErrorActionScope::None,
                    reason: "client_disconnect".to_string(),
                    duration_ms: None,
                    retry_eligible: false,
                    health_affecting: false,
                    exhaustion_effect: "health_neutral_client_disconnect".to_string(),
                },
                100,
            )
            .unwrap();
        assert!(
            store
                .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
    }

    #[test]
    fn provider_and_model_scopes_do_not_cross_contaminate() {
        let store = V3ProviderHealthStore::default();
        for scope in [
            V3ErrorActionScope::ProviderInstance {
                provider_id: "provider-a".to_string(),
            },
            V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-b".to_string(),
                model_id: "gpt-5.5".to_string(),
            },
        ] {
            store.apply_error_action(&action(scope), 100).unwrap();
        }
        assert!(
            !store
                .availability("provider-a", Some("key-a"), Some("other-model"), 101)
                .available
        );
        assert!(
            !store
                .availability("provider-b", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("provider-b", Some("key-a"), Some("other-model"), 101)
                .available
        );
        assert!(
            store
                .availability("third", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
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
