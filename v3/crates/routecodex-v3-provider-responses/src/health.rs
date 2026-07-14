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
    cooldowns: BTreeMap<String, V3ProviderCooldown>,
    quotas: BTreeMap<String, V3ProviderQuotaState>,
    concurrency: BTreeMap<String, V3ProviderConcurrencyState>,
}

#[derive(Debug, Clone)]
struct V3ProviderCooldown {
    reason: String,
    until_ms: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum V3ProviderHealthError {
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
        Self {
            state: Arc::new(RwLock::new(V3ProviderHealthState {
                configured_disabled,
                ..V3ProviderHealthState::default()
            })),
        }
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
    keys
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
                    provider_id: "cc".to_string(),
                    auth_alias: "key-a".to_string(),
                }),
                100,
            )
            .unwrap();
        assert_eq!(applied.scope_label, "auth_key:cc:key-a");
        assert!(
            !store
                .availability("cc", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("cc", Some("key-b"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("asxs", Some("key-a"), Some("gpt-5.5"), 101)
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
                .availability("cc", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
    }

    #[test]
    fn provider_and_model_scopes_do_not_cross_contaminate() {
        let store = V3ProviderHealthStore::default();
        for scope in [
            V3ErrorActionScope::ProviderInstance {
                provider_id: "cc".to_string(),
            },
            V3ErrorActionScope::CanonicalModel {
                provider_id: "asxs".to_string(),
                model_id: "gpt-5.5".to_string(),
            },
        ] {
            store.apply_error_action(&action(scope), 100).unwrap();
        }
        assert!(
            !store
                .availability("cc", Some("key-a"), Some("other-model"), 101)
                .available
        );
        assert!(
            !store
                .availability("asxs", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("asxs", Some("key-a"), Some("other-model"), 101)
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
                    provider_id: "cc".to_string(),
                    model_id: "gpt-5.5".to_string(),
                },
                0,
                Some(1_000),
            )
            .unwrap();
        assert!(
            !store
                .availability("cc", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("cc", Some("key-a"), Some("other-model"), 101)
                .available
        );
        store.update_concurrency_state("asxs", 2, 2).unwrap();
        assert!(
            !store
                .availability("asxs", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("third", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert_eq!(
            explain_provider_health_reasons(&store, "cc", Some("key-a"), Some("gpt-5.5"), 101,),
            vec!["quota:canonical_model:cc:gpt-5.5:exhausted"]
        );
    }
}
