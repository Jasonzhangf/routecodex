// feature_id: v3.provider_action_gate
// Provider lifecycle observations only. Requests never enter this scheduler.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use routecodex_v3_error::V3ProviderFailureSessionScope;
use tokio::time::Instant;

use crate::internal::provider_action_defaults;

pub const V3_PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 1_000;
pub const V3_PROVIDER_ACTION_MEDIUM_DELAY_MS: u64 = 3_000;
pub const V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS: u64 = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct V3ProviderActionProviderScope {
    pub server_id: String,
    pub routing_group: String,
    pub session_id: String,
    pub provider_runtime_identity: String,
}

impl V3ProviderActionProviderScope {
    pub fn new(
        scope: &V3ProviderFailureSessionScope,
        provider_runtime_identity: impl Into<String>,
    ) -> Result<Self, String> {
        Ok(Self {
            server_id: scope.server_id().to_string(),
            routing_group: scope.routing_group().to_string(),
            session_id: scope.session_id().to_string(),
            provider_runtime_identity: required_scope_part(
                provider_runtime_identity.into(),
                "provider_runtime_identity",
            )?,
        })
    }
}

#[derive(Debug, Clone, Eq)]
pub struct V3ProviderActionGateKey {
    pub provider_scope: V3ProviderActionProviderScope,
    pub session_id: String,
    pub normalized_error_family: String,
}

impl V3ProviderActionGateKey {
    pub fn new(
        scope: &V3ProviderFailureSessionScope,
        provider_runtime_identity: impl Into<String>,
        normalized_error_family: impl Into<String>,
    ) -> Result<Self, String> {
        let provider_scope =
            V3ProviderActionProviderScope::new(scope, provider_runtime_identity)?;
        let error_family =
            required_scope_part(normalized_error_family.into(), "normalized_error_family")?;
        Ok(Self {
            session_id: provider_scope.session_id.clone(),
            provider_scope,
            normalized_error_family: error_family,
        })
    }
}

impl PartialEq for V3ProviderActionGateKey {
    fn eq(&self, other: &Self) -> bool {
        self.provider_scope == other.provider_scope
            && self.normalized_error_family == other.normalized_error_family
    }
}

impl Hash for V3ProviderActionGateKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.provider_scope.hash(state);
        self.normalized_error_family.hash(state);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderActionGateMode {
    Isolated,
    Medium,
    Sustained,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderActionFailureRecorded {
    pub generation: u64,
    pub mode: V3ProviderActionGateMode,
    pub minimum_delay_ms: u64,
    recovery_ticket: V3ProviderActionRecoveryTicket,
}

impl V3ProviderActionFailureRecorded {
    pub fn recovery_ticket(&self) -> &V3ProviderActionRecoveryTicket {
        &self.recovery_ticket
    }
}

/// Exact generation of a pending Provider observation. No request consumes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderActionRecoveryTicket {
    key: V3ProviderActionGateKey,
    generation: u64,
}

impl V3ProviderActionRecoveryTicket {
    pub fn key(&self) -> &V3ProviderActionGateKey {
        &self.key
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Debug)]
struct V3ProviderObservationState {
    generation: u64,
    mode: V3ProviderActionGateMode,
    consecutive_failures: u64,
    next_observation_at: Instant,
    minimum_delay_ms: u64,
    observing_generation: Option<u64>,
    updated_at: Instant,
}

#[derive(Debug, Default)]
struct V3ProviderActionGateInner {
    states: Mutex<HashMap<V3ProviderActionGateKey, V3ProviderObservationState>>,
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderActionGate {
    inner: Arc<V3ProviderActionGateInner>,
}

/// Held only by the independent Provider precool observation owner.
#[derive(Debug)]
pub(crate) struct V3ProviderObservationLease {
    gate: V3ProviderActionGate,
    key: V3ProviderActionGateKey,
    generation: u64,
}

impl Drop for V3ProviderObservationLease {
    fn drop(&mut self) {
        let _ = self.gate.release_observation(&self.key, self.generation);
    }
}

impl V3ProviderActionGate {
    pub(crate) fn try_admit_observation(
        &self,
        key: &V3ProviderActionGateKey,
    ) -> Result<Option<V3ProviderObservationLease>, String> {
        let mut states = self.lock_states()?;
        let Some(state) = states.get_mut(key) else {
            return Ok(None);
        };
        let now = Instant::now();
        if now < state.next_observation_at || state.observing_generation.is_some() {
            return Ok(None);
        }
        state.observing_generation = Some(state.generation);
        state.updated_at = now;
        Ok(Some(V3ProviderObservationLease {
            gate: self.clone(),
            key: key.clone(),
            generation: state.generation,
        }))
    }

    pub fn process_shared() -> Self {
        static SHARED: OnceLock<V3ProviderActionGate> = OnceLock::new();
        SHARED.get_or_init(Self::default).clone()
    }

    pub fn record_success(&self, key: &V3ProviderActionGateKey) -> Result<(), String> {
        self.lock_states()?.remove(key);
        Ok(())
    }

    pub fn record_provider_success(
        &self,
        scope: &V3ProviderActionProviderScope,
    ) -> Result<(), String> {
        self.lock_states()?
            .retain(|key, _| key.provider_scope != *scope);
        Ok(())
    }

    fn release_observation(
        &self,
        key: &V3ProviderActionGateKey,
        generation: u64,
    ) -> Result<(), String> {
        let mut states = self.lock_states()?;
        let Some(state) = states.get_mut(key) else {
            return Ok(());
        };
        if state.observing_generation != Some(generation) {
            return Ok(());
        }
        state.observing_generation = None;
        let now = Instant::now();
        state.generation = state.generation.saturating_add(1);
        state.mode = V3ProviderActionGateMode::Sustained;
        state.next_observation_at =
            now + Duration::from_millis(provider_action_defaults().action_sustained_delay_ms);
        state.updated_at = now;
        Ok(())
    }

    pub fn record_failure(
        &self,
        key: &V3ProviderActionGateKey,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.record_failure_with_minimum_delay(key, 0)
    }

    pub fn record_failure_with_minimum_delay(
        &self,
        key: &V3ProviderActionGateKey,
        configured_minimum_delay_ms: u64,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        let now = Instant::now();
        let mut states = self.lock_states()?;
        let idle_ttl = Duration::from_millis(provider_action_defaults().action_idle_ttl_ms);
        states.retain(|_, state| {
            state.observing_generation.is_some()
                || now.saturating_duration_since(state.updated_at) < idle_ttl
        });
        let state = states
            .entry(key.clone())
            .or_insert(V3ProviderObservationState {
                generation: 0,
                mode: V3ProviderActionGateMode::Isolated,
                consecutive_failures: 0,
                next_observation_at: now,
                minimum_delay_ms: 0,
                observing_generation: None,
                updated_at: now,
            });
        if state.observing_generation.is_none() {
            state.generation = state.generation.saturating_add(1);
            state.observing_generation = None;
        }
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        state.mode = match state.consecutive_failures {
            1 => V3ProviderActionGateMode::Isolated,
            2 => V3ProviderActionGateMode::Medium,
            _ => V3ProviderActionGateMode::Sustained,
        };
        state.minimum_delay_ms = mode_delay_ms(state.mode).max(configured_minimum_delay_ms);
        state.next_observation_at = now + Duration::from_millis(state.minimum_delay_ms);
        state.updated_at = now;
        Ok(V3ProviderActionFailureRecorded {
            generation: state.generation,
            mode: state.mode,
            minimum_delay_ms: state.minimum_delay_ms,
            recovery_ticket: V3ProviderActionRecoveryTicket {
                key: key.clone(),
                generation: state.generation,
            },
        })
    }

    #[cfg(test)]
    pub(crate) fn observation_due_at(
        &self,
        key: &V3ProviderActionGateKey,
    ) -> Result<Instant, String> {
        self.lock_states()?
            .get(key)
            .map(|state| state.next_observation_at)
            .ok_or_else(|| "provider observation has no pending failure".to_string())
    }

    fn lock_states(
        &self,
    ) -> Result<MutexGuard<'_, HashMap<V3ProviderActionGateKey, V3ProviderObservationState>>, String>
    {
        self.inner
            .states
            .lock()
            .map_err(|_| "provider observation state lock is poisoned".to_string())
    }
}

fn mode_delay_ms(mode: V3ProviderActionGateMode) -> u64 {
    let defaults = provider_action_defaults();
    match mode {
        V3ProviderActionGateMode::Isolated => defaults.action_isolated_delay_ms,
        V3ProviderActionGateMode::Medium => defaults.action_medium_delay_ms,
        V3ProviderActionGateMode::Sustained => defaults.action_sustained_delay_ms,
    }
}

fn required_scope_part(value: String, field: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!("provider observation {field} cannot be empty"));
    }
    Ok(normalized.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn provider_observations_are_due_and_independent_by_identity() {
        let session = V3ProviderFailureSessionScope::new("server", "routing", "session").unwrap();
        let a = V3ProviderActionGateKey::new(&session, "a:default:key:model", "provider_pre_cool")
            .unwrap();
        let b = V3ProviderActionGateKey::new(&session, "b:default:key:model", "provider_pre_cool")
            .unwrap();
        let gate = V3ProviderActionGate::default();
        gate.record_failure(&a).unwrap();
        gate.record_failure(&b).unwrap();
        assert!(gate.try_admit_observation(&a).unwrap().is_none());
        tokio::time::sleep_until(gate.observation_due_at(&b).unwrap()).await;
        let lease_a = gate.try_admit_observation(&a).unwrap().expect("A is due");
        assert!(gate.try_admit_observation(&a).unwrap().is_none());
        let lease_b = gate
            .try_admit_observation(&b)
            .unwrap()
            .expect("B remains independent");
        gate.record_success(&a).unwrap();
        assert!(gate.try_admit_observation(&b).unwrap().is_none());
        drop(lease_a);
        drop(lease_b);
        assert!(
            gate.try_admit_observation(&b).unwrap().is_none(),
            "failed observation retains its cadence"
        );
    }
}
