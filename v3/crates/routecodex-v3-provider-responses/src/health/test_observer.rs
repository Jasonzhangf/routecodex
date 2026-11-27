use super::{V3ProviderHealthState, V3ProviderHealthStore};
use std::future::Future;

pub struct V3ProviderHealthTestPersistenceReceiptHold {
    inner: super::persistence::V3ProviderHealthPersistenceReceiptHold,
}

impl V3ProviderHealthTestPersistenceReceiptHold {
    pub fn wait_until_receipt_is_held(&self, timeout: std::time::Duration) -> Result<(), String> {
        self.inner.wait_until_receipt_is_held(timeout)
    }

    pub fn release(&self) -> Result<(), String> {
        self.inner.release()
    }
}

#[derive(Debug, PartialEq, Eq)]
struct V3ProviderHealthDecisionSnapshot {
    last_probe_acquisition_id: u64,
    configured_disabled: std::collections::BTreeSet<String>,
    health_disabled: std::collections::BTreeSet<String>,
    failure_policies: std::collections::BTreeMap<String, super::V3ProviderFailurePolicy>,
    consecutive_failures: std::collections::BTreeMap<
        super::V3ProviderFailureSessionKey,
        super::V3ProviderConsecutiveFailure,
    >,
    cooldowns:
        std::collections::BTreeMap<super::V3ProviderFailureSessionKey, super::V3ProviderCooldown>,
    auth_key_cooldowns: std::collections::BTreeMap<
        crate::provider_cooldown_probe::V3ProviderCooldownProbeKey,
        super::V3ProviderCooldown,
    >,
    provider_cooldown_probes: std::collections::BTreeMap<
        crate::provider_cooldown_probe::V3ProviderCooldownProbeKey,
        crate::provider_cooldown_probe::V3ProviderCooldownProbeState,
    >,
    precool_observation_probes: std::collections::BTreeMap<
        crate::provider_cooldown_probe::V3ProviderCooldownProbeKey,
        crate::key_health::V3ProbeAcquisitionId,
    >,
    adaptive_history: std::collections::BTreeMap<
        crate::provider_cooldown_probe::V3ProviderCooldownProbeKey,
        super::V3ProviderAdaptiveHistory,
    >,
    quotas: std::collections::BTreeMap<String, super::V3ProviderQuotaState>,
    concurrency: std::collections::BTreeMap<String, super::V3ProviderConcurrencyState>,
}

#[derive(Debug, PartialEq, Eq)]
struct V3ProviderHealthStoreSnapshot {
    decision: V3ProviderHealthDecisionSnapshot,
    availability_generation: u64,
    persistence_present: bool,
    persistence_alarm: Option<String>,
}

fn snapshot(store: &V3ProviderHealthStore) -> V3ProviderHealthStoreSnapshot {
    let (decision, persistence_present) = {
        let state = store
            .state
            .read()
            .expect("provider health test observer lock must not be poisoned");
        let V3ProviderHealthState {
            last_probe_acquisition_id,
            persistence,
            configured_disabled,
            health_disabled,
            failure_policies,
            consecutive_failures,
            cooldowns,
            auth_key_cooldowns,
            provider_cooldown_probes,
            precool_observation_probes,
            adaptive_history,
            quotas,
            concurrency,
        } = &*state;
        (
            V3ProviderHealthDecisionSnapshot {
                last_probe_acquisition_id: *last_probe_acquisition_id,
                configured_disabled: configured_disabled.clone(),
                health_disabled: health_disabled.clone(),
                failure_policies: failure_policies.clone(),
                consecutive_failures: consecutive_failures.clone(),
                cooldowns: cooldowns.clone(),
                auth_key_cooldowns: auth_key_cooldowns.clone(),
                provider_cooldown_probes: provider_cooldown_probes.clone(),
                precool_observation_probes: precool_observation_probes.clone(),
                adaptive_history: adaptive_history.clone(),
                quotas: quotas.clone(),
                concurrency: concurrency.clone(),
            },
            persistence.is_some(),
        )
    };
    V3ProviderHealthStoreSnapshot {
        decision,
        availability_generation: store.availability_generation(),
        persistence_present,
        persistence_alarm: store.persistence_alarm(),
    }
}

fn differing_component(
    before: &V3ProviderHealthStoreSnapshot,
    after: &V3ProviderHealthStoreSnapshot,
) -> Option<&'static str> {
    let left = &before.decision;
    let right = &after.decision;
    if left.last_probe_acquisition_id != right.last_probe_acquisition_id {
        Some("last_probe_acquisition_id")
    } else if left.configured_disabled != right.configured_disabled {
        Some("configured_disabled")
    } else if left.health_disabled != right.health_disabled {
        Some("health_disabled")
    } else if left.failure_policies != right.failure_policies {
        Some("failure_policies")
    } else if left.consecutive_failures != right.consecutive_failures {
        Some("consecutive_failures")
    } else if left.cooldowns != right.cooldowns {
        Some("cooldowns")
    } else if left.auth_key_cooldowns != right.auth_key_cooldowns {
        Some("auth_key_cooldowns")
    } else if left.provider_cooldown_probes != right.provider_cooldown_probes {
        Some("provider_cooldown_probes")
    } else if left.precool_observation_probes != right.precool_observation_probes {
        Some("precool_observation_probes")
    } else if left.adaptive_history != right.adaptive_history {
        Some("adaptive_history")
    } else if left.quotas != right.quotas {
        Some("quotas")
    } else if left.concurrency != right.concurrency {
        Some("concurrency")
    } else if before.availability_generation != after.availability_generation {
        Some("availability_generation")
    } else if before.persistence_present != after.persistence_present {
        Some("persistence_present")
    } else if before.persistence_alarm != after.persistence_alarm {
        Some("persistence_alarm")
    } else {
        None
    }
}

async fn assert_health_unchanged_during<F, T>(stores: &[V3ProviderHealthStore], action: F) -> T
where
    F: Future<Output = T>,
{
    let before = stores.iter().map(snapshot).collect::<Vec<_>>();
    let result = action.await;
    let after = stores.iter().map(snapshot).collect::<Vec<_>>();
    for (index, (before, after)) in before.iter().zip(&after).enumerate() {
        if let Some(component) = differing_component(before, after) {
            panic!(
                "provider health changed across test action: store_index={index} component={component}"
            );
        }
    }
    result
}

impl V3ProviderHealthStore {
    /// Test-only assertion over the exact supplied stores. No lock is held
    /// while the asynchronous action runs, and no snapshot escapes the owner.
    pub async fn assert_health_unchanged_during<F, T>(&self, stores: &[Self], action: F) -> T
    where
        F: Future<Output = T>,
    {
        assert_health_unchanged_during(stores, action).await
    }

    pub fn hold_next_persistence_flush_receipt_for_test(
        &self,
    ) -> Result<V3ProviderHealthTestPersistenceReceiptHold, String> {
        let state = self
            .state
            .read()
            .map_err(|error| format!("provider health test observer lock poisoned: {error}"))?;
        let writer = state.persistence.as_ref().ok_or_else(|| {
            "provider health persistence writer is not installed for this store".to_string()
        })?;
        let inner = writer.hold_next_flush_receipt()?;
        Ok(V3ProviderHealthTestPersistenceReceiptHold { inner })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    fn persistence_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
        routecodex_v3_config::compile_v3_config_05_manifest(
            routecodex_v3_config::parse_v3_config_02_authoring(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
            )
            .expect("test authoring must parse"),
        )
        .expect("test manifest must compile")
    }

    fn populated_store() -> V3ProviderHealthStore {
        let store = V3ProviderHealthStore::default();
        store
            .record_provider_key_success_for_interface("test", "default", "key", "test", 11)
            .unwrap();
        let state = store.state.write().unwrap();
        let key = crate::provider_cooldown_probe::provider_cooldown_probe_key_for_interface(
            "test",
            "default",
            Some("key"),
            Some("test"),
        );
        let history = state.adaptive_history.get(&key).unwrap();
        assert_eq!(history.success_streak, 1);
        assert_eq!(history.last_success_at_ms, Some(11));
        drop(state);
        store
    }

    #[tokio::test]
    async fn unchanged_store_passes_the_exact_instance_observer() {
        let store = populated_store();
        let stores = [store];
        let value = stores[0]
            .assert_health_unchanged_during(&stores, async { 7 })
            .await;
        assert_eq!(value, 7);
    }

    #[tokio::test]
    async fn populated_default_identity_history_reset_is_detected() {
        let store = populated_store();
        let stores = [store.clone()];
        let error = std::panic::AssertUnwindSafe(stores[0].assert_health_unchanged_during(
            &stores,
            async {
                let key = crate::provider_cooldown_probe::provider_cooldown_probe_key_for_interface(
                    "test",
                    "default",
                    Some("key"),
                    Some("test"),
                );
                assert!(store
                    .state
                    .write()
                    .unwrap()
                    .adaptive_history
                    .remove(&key)
                    .is_some());
            },
        ))
        .catch_unwind()
        .await
        .expect_err("resetting the populated declared identity must fail exact equality");
        let message = error.downcast_ref::<String>().unwrap();
        assert!(message.contains("component=adaptive_history"), "{message}");
    }

    #[tokio::test]
    async fn hidden_adaptive_counter_mutation_is_detected() {
        let store = populated_store();
        assert!(store.cooldown_entries(11).is_empty());
        let stores = [store.clone()];
        let error = std::panic::AssertUnwindSafe(stores[0].assert_health_unchanged_during(
            &stores,
            async {
                let mut state = store.state.write().unwrap();
                let key = crate::provider_cooldown_probe::provider_cooldown_probe_key_for_interface(
                    "test",
                    "default",
                    Some("key"),
                    Some("test"),
                );
                state.adaptive_history.get_mut(&key).unwrap().attempts += 1;
            },
        ))
        .catch_unwind()
        .await
        .expect_err("a hidden history mutation must fail the observer");
        let message = error
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| error.downcast_ref::<&str>().copied())
            .unwrap_or_default();
        assert!(message.contains("component=adaptive_history"), "{message}");
        assert!(store.cooldown_entries(11).is_empty());
    }

    #[test]
    fn responsive_receipt_hold_releases_the_existing_flush() {
        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let path = root.path().join("provider-cooldowns.json");
        let manifest = persistence_manifest();
        let store = V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path);
        let hold = store
            .hold_next_persistence_flush_receipt_for_test()
            .expect("arm the actual persistence receipt hold");
        let flush_store = store.clone();
        let (completed, completion) = std::sync::mpsc::channel();
        let flush = std::thread::spawn(move || {
            let _ = completed.send(flush_store.flush_persistence());
        });

        hold.wait_until_receipt_is_held(std::time::Duration::from_secs(2))
            .expect("the existing writer must reach the held receipt");
        hold.release().expect("release the held receipt");
        let result = completion
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("release must complete the actual flush within the bound");
        flush.join().expect("completed flush thread must join");
        assert_eq!(result, Ok(()));
        assert_eq!(store.persistence_alarm(), None);
    }

    #[test]
    fn dropping_unobserved_receipt_hold_releases_the_existing_flush() {
        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let store = V3ProviderHealthStore::from_manifest_with_persistence_path(
            &persistence_manifest(),
            root.path().join("provider-cooldowns.json"),
        );
        let hold = store
            .hold_next_persistence_flush_receipt_for_test()
            .unwrap();
        // Drop before Flush reaches the writer. Neither signal needs a waiting
        // controller, and the real writer must still complete its receipt.
        drop(hold);
        let (completed, completion) = std::sync::mpsc::channel();
        let flush = std::thread::spawn(move || {
            let _ = completed.send(store.flush_persistence());
        });
        assert_eq!(
            completion
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap(),
            Ok(())
        );
        flush.join().unwrap();
    }
}
