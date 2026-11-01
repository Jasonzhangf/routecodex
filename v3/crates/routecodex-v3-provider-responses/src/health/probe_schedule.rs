use super::{persistence, V3ProviderHealthError, V3ProviderHealthState, V3ProviderHealthStore};
use crate::key_health::{
    V3ProbeAcquisitionId, V3ProviderHealthProbePermit, V3ProviderPrecoolObservationOutcome,
    V3ProviderProbePurpose,
};
use crate::provider_cooldown_probe::{
    provider_cooldown_probe_key_for_interface, resolve_provider_cooldown_probe_key_for_interface,
};
use persistence::persist_cooldown_state;

pub type V3ProviderCooldownProbeKey = (String, Option<String>, Option<String>);
pub type V3ProviderCooldownProbeKeyWithInterface = (String, String, Option<String>, Option<String>);

impl V3ProviderHealthStore {
    /// provider 级冷却中、冷却已到期且 probe 到期的 provider 列表
    /// （(provider_id, auth_alias, model_id)）。由后台 probe 循环消费。
    #[allow(clippy::type_complexity)]
    pub fn provider_cooldown_probe_keys(
        &self,
        now_ms: u64,
        startup: bool,
    ) -> Result<Vec<V3ProviderCooldownProbeKey>, V3ProviderHealthError> {
        Ok(self
            .provider_cooldown_probe_keys_with_interface(now_ms, startup)?
            .into_iter()
            .map(|(provider_id, _, auth_alias, model_id)| (provider_id, auth_alias, model_id))
            .collect())
    }

    #[allow(clippy::type_complexity)]
    pub fn provider_cooldown_probe_keys_with_interface(
        &self,
        now_ms: u64,
        startup: bool,
    ) -> Result<Vec<V3ProviderCooldownProbeKeyWithInterface>, V3ProviderHealthError> {
        let keys = self.provider_cooldown_scoped_probe_keys(now_ms, startup)?;
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        Ok(keys
            .into_iter()
            .filter_map(|key| {
                let probe = state.provider_cooldown_probes.get(&key)?;
                Some((
                    key.provider_id,
                    key.interface_id,
                    key.auth_alias,
                    probe.probe_model_id.clone(),
                ))
            })
            .collect())
    }

    pub fn provider_cooldown_scoped_probe_keys(
        &self,
        now_ms: u64,
        startup: bool,
    ) -> Result<
        Vec<crate::provider_cooldown_probe::V3ProviderCooldownProbeKey>,
        V3ProviderHealthError,
    > {
        let expired = {
            let state = self
                .state
                .read()
                .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
            state
                .adaptive_history
                .keys()
                .filter(|key| super::rate_limit::is_expired_day(&state, key, now_ms))
                .cloned()
                .collect::<Vec<_>>()
        };
        if !expired.is_empty() {
            let mut state = self
                .state
                .write()
                .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
            let changed = expired.iter().fold(false, |changed, key| {
                super::rate_limit::reset_expired_day(&mut state, key, now_ms) || changed
            });
            if changed {
                persist_cooldown_state(state);
                self.publish_availability_change();
            }
        }
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        Ok(state
            .provider_cooldown_probes
            .iter()
            .filter(|(_, probe_state)| {
                probe_state.active_probe.is_none()
                    && probe_state.blocked_until_ms.is_some()
                    && ((startup
                        && probe_state.cooldown_cause
                            != Some(
                                crate::global_cooldown::V3ProviderCooldownFailureClass::RateLimit,
                            ))
                        || probe_state
                            .next_probe_at_ms
                            .is_some_and(|next_probe_at_ms| next_probe_at_ms <= now_ms))
            })
            .map(|(key, _)| key.clone())
            .collect())
    }

    pub fn provider_cooldown_probe_keys_due(
        &self,
        now_ms: u64,
    ) -> Result<Vec<V3ProviderCooldownProbeKey>, V3ProviderHealthError> {
        self.provider_cooldown_probe_keys(now_ms, false)
    }

    pub fn provider_cooldown_probe_next_deadline_ms(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<u64>, V3ProviderHealthError> {
        self.provider_cooldown_probe_next_deadline_ms_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
        )
    }

    pub fn provider_cooldown_probe_next_deadline_ms_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<u64>, V3ProviderHealthError> {
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let key = resolve_provider_cooldown_probe_key_for_interface(
            &state.provider_cooldown_probes,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        Ok(state
            .provider_cooldown_probes
            .get(&key)
            .filter(|probe_state| probe_state.active_probe.is_none())
            .and_then(|probe_state| probe_state.next_probe_at_ms))
    }

    pub fn has_provider_cooldown_probe_pending(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<bool, V3ProviderHealthError> {
        self.has_provider_cooldown_probe_pending_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
        )
    }

    pub fn has_provider_cooldown_probe_pending_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<bool, V3ProviderHealthError> {
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        Ok(state
            .provider_cooldown_probes
            .iter()
            .any(|(key, probe_state)| {
                key.provider_id == provider_id
                    && key.interface_id == interface_id
                    && key.auth_alias.as_deref() == auth_alias
                    && (key.model_id.as_deref() == model_id || key.model_id.is_none())
                    && (probe_state.active_probe.is_some()
                        || probe_state.next_probe_at_ms.is_some()
                        || probe_state.blocked_until_ms.is_some())
            }))
    }

    pub fn acquire_provider_cooldown_probe_if_due(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_probe_at(provider_id, auth_alias, model_id, Some(now_ms))
    }

    pub fn acquire_provider_cooldown_probe_if_due_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_probe_at_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            Some(now_ms),
            false,
        )
    }

    /// Recheck the deadline under the acquisition lock, including for a
    /// startup sweep. Startup may bypass only non-429 probe schedules.
    pub fn acquire_provider_cooldown_probe_for_sweep(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
        startup: bool,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_probe_at_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            Some(now_ms),
            startup,
        )
    }

    pub(super) fn acquire_provider_cooldown_probe_at(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        due_at_or_before_ms: Option<u64>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_probe_at_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            due_at_or_before_ms,
            false,
        )
    }

    pub(super) fn acquire_provider_cooldown_probe_at_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        due_at_or_before_ms: Option<u64>,
        startup: bool,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let key = resolve_provider_cooldown_probe_key_for_interface(
            &state.provider_cooldown_probes,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        drop(state);
        self.acquire_provider_cooldown_probe_for_key(&key, due_at_or_before_ms, startup)
    }

    pub fn acquire_provider_cooldown_probe_for_key(
        &self,
        key: &crate::provider_cooldown_probe::V3ProviderCooldownProbeKey,
        due_at_or_before_ms: Option<u64>,
        startup: bool,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        // One physical probe slot per complete identity: a held pre-cool
        // observation owns it until it is closed or cancelled.
        if precool_observation_conflicts(&state, key, key.model_id.as_deref()) {
            return Ok(None);
        }
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(key) else {
            return Ok(None);
        };
        if probe_state.active_probe.is_some()
            || probe_state.blocked_until_ms.is_none()
            || probe_state.next_probe_at_ms.is_none()
            || (!(startup
                && probe_state.cooldown_cause
                    != Some(crate::global_cooldown::V3ProviderCooldownFailureClass::RateLimit))
                && due_at_or_before_ms.is_some_and(|now_ms| {
                    probe_state
                        .next_probe_at_ms
                        .is_some_and(|next| next > now_ms)
                }))
        {
            return Ok(None);
        }
        let acquisition_id = allocate_probe_acquisition(&mut state)?;
        state
            .provider_cooldown_probes
            .get_mut(key)
            .unwrap()
            .active_probe = Some(acquisition_id);
        let expected_generation = state
            .adaptive_history
            .get(key)
            .map_or(0, |history| history.score_generation);
        persist_cooldown_state(state);
        Ok(Some(
            V3ProviderHealthProbePermit::new(
                key.provider_id.clone(),
                key.interface_id.clone(),
                key.auth_alias.clone(),
                key.model_id.clone(),
                expected_generation,
                acquisition_id,
            )
            .with_health_scope(key.scope.clone()),
        ))
    }

    /// 完整候选集耗尽时，每个 cooldown generation 只允许一次强制自救 probe。
    pub(super) fn acquire_provider_cooldown_rescue_probe_impl_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let key = resolve_provider_cooldown_probe_key_for_interface(
            &state.provider_cooldown_probes,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        if precool_observation_conflicts(&state, &key, model_id) {
            return Ok(None);
        }
        let Some(probe_state) = state.provider_cooldown_probes.get(&key) else {
            return Ok(None);
        };
        if probe_state.active_probe.is_some()
            || probe_state.rescue_probe_attempted
            || probe_state.cooldown_cause
                == Some(crate::global_cooldown::V3ProviderCooldownFailureClass::RateLimit)
        {
            return Ok(None);
        }
        let acquisition_id = allocate_probe_acquisition(&mut state)?;
        let probe_state = state.provider_cooldown_probes.get_mut(&key).unwrap();
        probe_state.active_probe = Some(acquisition_id);
        probe_state.rescue_probe_attempted = true;
        let expected_generation = state
            .adaptive_history
            .get(&key)
            .map_or(0, |history| history.score_generation);
        persist_cooldown_state(state);
        Ok(Some(V3ProviderHealthProbePermit::new(
            provider_id.to_string(),
            key.interface_id.clone(),
            auth_alias.map(str::to_string),
            key.model_id.clone(),
            expected_generation,
            acquisition_id,
        )))
    }

    /// Release this acquisition without changing health or its stored schedule.
    pub fn cancel_provider_cooldown_probe(
        &self,
        permit: &V3ProviderHealthProbePermit,
    ) -> Result<(), V3ProviderHealthError> {
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if !release_probe_acquisition(&mut state, permit) {
            return Ok(());
        }
        // A pre-cool slot owns no persisted schedule; only the cooldown purpose
        // writes the cooldown store.
        if permit.purpose() == V3ProviderProbePurpose::CooldownRecovery {
            persist_cooldown_state(state);
        } else {
            drop(state);
        }
        self.publish_availability_change();
        Ok(())
    }

    /// Acquire the single physical probe slot for a healthy/held identity that
    /// has not been cooled.
    ///
    /// This creates no cooldown entry, no schedule, no health failure and no
    /// `blocked_until_ms`. It only records ephemeral ownership of the probe
    /// slot for the complete provider/interface/auth/model identity. A cooled
    /// identity, an explicit auth hold or an already owned slot yields `None`.
    pub fn acquire_provider_precool_probe_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_uncooled_observation_probe_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            V3ProviderProbePurpose::PrecoolObservation,
        )
    }

    pub fn acquire_provider_startup_probe_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_uncooled_observation_probe_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            V3ProviderProbePurpose::StartupObservation,
        )
    }

    fn acquire_uncooled_observation_probe_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        purpose: V3ProviderProbePurpose,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) else {
            // Observation requires the complete identity; never widen to a
            // provider or auth-key scope.
            return Ok(None);
        };
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let resolved = resolve_provider_cooldown_probe_key_for_interface(
            &state.provider_cooldown_probes,
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let auth_key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            None,
        );
        if state.health_disabled.contains(provider_id)
            || state.configured_disabled.contains(provider_id)
            || state.provider_cooldown_probes.contains_key(&resolved)
            || state.provider_cooldown_probes.contains_key(&auth_key)
            || state.auth_key_cooldowns.contains_key(&key)
            || state.auth_key_cooldowns.contains_key(&auth_key)
            || state.precool_observation_probes.contains_key(&key)
        {
            return Ok(None);
        }
        let acquisition_id = allocate_probe_acquisition(&mut state)?;
        state
            .precool_observation_probes
            .insert(key.clone(), acquisition_id);
        let expected_generation = state
            .adaptive_history
            .get(&key)
            .map_or(0, |history| history.score_generation);
        Ok(Some(V3ProviderHealthProbePermit::new_with_purpose(
            provider_id.to_string(),
            key.interface_id.clone(),
            Some(auth_alias.to_string()),
            key.model_id.clone(),
            expected_generation,
            acquisition_id,
            purpose,
        )))
    }

    /// Authoritative ownership check for a held pre-cool observation permit.
    ///
    /// Current means both that this exact acquisition still owns the physical
    /// probe slot and that the health generation it was acquired against has
    /// not moved. Matching business success or a newer failure moves that
    /// generation, so an old observation can never be reused.
    pub fn provider_precool_observation_permit_is_current(
        &self,
        permit: &V3ProviderHealthProbePermit,
    ) -> Result<bool, V3ProviderHealthError> {
        if permit.purpose() != V3ProviderProbePurpose::PrecoolObservation {
            return Ok(false);
        }
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let key = permit.cooldown_key();
        if state.precool_observation_probes.get(&key) != Some(&permit.acquisition_id) {
            return Ok(false);
        }
        Ok(state
            .adaptive_history
            .get(&key)
            .map_or(0, |history| history.score_generation)
            == permit.expected_generation())
    }

    /// Close one owned pre-cool observation and report the typed fact.
    ///
    /// This is probe recovery only, gated by the same acquisition ID and health
    /// generation the slot was acquired against. It resets the adaptive failure
    /// window because a successful probe is real reachability evidence, but it
    /// writes no cooldown entry, no `blocked_until_ms`, no business score (+1),
    /// no business success streak. A qualified real success advances the
    /// observation generation so older probes cannot override recovery. A failed
    /// observation is closed through the release API instead: the failure
    /// stays available to Runtime's pending-action owner, which alone may
    /// submit a cooldown.
    pub fn complete_provider_precool_observation_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        now_ms: u64,
    ) -> Result<V3ProviderPrecoolObservationOutcome, V3ProviderHealthError> {
        self.complete_uncooled_observation_with_permit(
            permit,
            now_ms,
            V3ProviderProbePurpose::PrecoolObservation,
        )
    }

    pub fn complete_provider_startup_probe_success_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        now_ms: u64,
    ) -> Result<V3ProviderPrecoolObservationOutcome, V3ProviderHealthError> {
        self.complete_uncooled_observation_with_permit(
            permit,
            now_ms,
            V3ProviderProbePurpose::StartupObservation,
        )
    }

    /// Commit a real startup-probe failure only while this acquisition and
    /// its observed health generation remain current.
    pub fn complete_provider_startup_probe_failure_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        status: Option<u16>,
        now_ms: u64,
    ) -> Result<V3ProviderPrecoolObservationOutcome, V3ProviderHealthError> {
        if permit.purpose() != V3ProviderProbePurpose::StartupObservation {
            return Err(V3ProviderHealthError::ProbePurposeMismatch);
        }
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let key = permit.cooldown_key();
        let current = state.precool_observation_probes.get(&key) == Some(&permit.acquisition_id)
            && state
                .adaptive_history
                .get(&key)
                .map_or(0, |history| history.score_generation)
                == permit.expected_generation()
            && !has_manual_hold(&state, &key);
        release_probe_acquisition(&mut state, permit);
        if !current {
            return Ok(V3ProviderPrecoolObservationOutcome::Superseded);
        }
        if !state.health_disabled.contains(&key.provider_id)
            && status
                .is_none_or(|value| (100..=599).contains(&value) && !(200..300).contains(&value))
        {
            Self::record_real_failure_locked(&mut state, &key, status, now_ms);
        }
        drop(state);
        self.publish_availability_change();
        Ok(V3ProviderPrecoolObservationOutcome::Completed)
    }

    fn complete_uncooled_observation_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        now_ms: u64,
        purpose: V3ProviderProbePurpose,
    ) -> Result<V3ProviderPrecoolObservationOutcome, V3ProviderHealthError> {
        if permit.purpose() != purpose {
            return Err(V3ProviderHealthError::ProbePurposeMismatch);
        }
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if purpose == V3ProviderProbePurpose::StartupObservation
            && has_manual_hold(&state, &permit.cooldown_key())
        {
            release_probe_acquisition(&mut state, permit);
            return Ok(V3ProviderPrecoolObservationOutcome::Superseded);
        }
        let outcome = close_precool_observation(&mut state, permit);
        if outcome == V3ProviderPrecoolObservationOutcome::Completed {
            let key = permit.cooldown_key();
            super::recover_other_scopes_from_qualified_probe(&mut state, &key, now_ms);
            let history = state.adaptive_history.entry(key).or_default();
            history.real_error_streak = 0;
            history.first_global_429_ms = None;
            history.recovery_success_revision = history.recovery_success_revision.saturating_add(1);
            history.score_generation = history.score_generation.saturating_add(1);
        }
        drop(state);
        if outcome == V3ProviderPrecoolObservationOutcome::Completed {
            self.publish_availability_change();
        }
        Ok(outcome)
    }
}

fn has_manual_hold(
    state: &V3ProviderHealthState,
    key: &crate::provider_cooldown_probe::V3ProviderCooldownProbeKey,
) -> bool {
    let mut auth_key = key.clone();
    auth_key.model_id = None;
    let held = [key, &auth_key].into_iter().any(|candidate| {
        state
            .provider_cooldown_probes
            .get(candidate)
            .is_some_and(|probe| {
                probe.cooldown_cause
                    == Some(crate::global_cooldown::V3ProviderCooldownFailureClass::ManualAuth)
            })
    });
    held
}

fn allocate_probe_acquisition(
    state: &mut V3ProviderHealthState,
) -> Result<V3ProbeAcquisitionId, V3ProviderHealthError> {
    state.last_probe_acquisition_id = state
        .last_probe_acquisition_id
        .checked_add(1)
        .ok_or(V3ProviderHealthError::ProbeAcquisitionExhausted)?;
    Ok(V3ProbeAcquisitionId(state.last_probe_acquisition_id))
}

/// A pre-cool observation holds the physical probe slot for the exact complete
/// identity, and an auth-key-slot acquisition conflicts with every model under
/// that auth key. Sibling identities remain independent.
fn precool_observation_conflicts(
    state: &V3ProviderHealthState,
    key: &crate::provider_cooldown_probe::V3ProviderCooldownProbeKey,
    model_id: Option<&str>,
) -> bool {
    if state.precool_observation_probes.contains_key(key) {
        return true;
    }
    // An auth-scope acquisition owns the whole provider+auth probe slot, so it
    // conflicts with any held model observation under that auth key.
    if model_id.is_none() {
        return state.precool_observation_probes.keys().any(|held| {
            held.provider_id == key.provider_id
                && held.interface_id == key.interface_id
                && held.auth_alias == key.auth_alias
        });
    }
    // A held auth-scope observation owns the whole slot for this auth key.
    let auth_key = crate::provider_cooldown_probe::V3ProviderCooldownProbeKey {
        model_id: None,
        ..key.clone()
    };
    state.precool_observation_probes.contains_key(&auth_key)
}

pub(super) fn release_probe_acquisition(
    state: &mut V3ProviderHealthState,
    permit: &V3ProviderHealthProbePermit,
) -> bool {
    if matches!(
        permit.purpose(),
        V3ProviderProbePurpose::PrecoolObservation | V3ProviderProbePurpose::StartupObservation
    ) {
        return released_precool_ownership(state, permit);
    }
    // Use the acquired key exactly; never resolve an old permit onto a new scope.
    let key = permit.cooldown_key();
    let Some(probe) = state.provider_cooldown_probes.get_mut(&key) else {
        return false;
    };
    if probe.active_probe != Some(permit.acquisition_id) {
        return false;
    }
    probe.active_probe = None;
    true
}

/// Remove this permit's pre-cool slot when it is still the owner.
fn released_precool_ownership(
    state: &mut V3ProviderHealthState,
    permit: &V3ProviderHealthProbePermit,
) -> bool {
    let key = permit.cooldown_key();
    if state.precool_observation_probes.get(&key) != Some(&permit.acquisition_id) {
        return false;
    }
    state.precool_observation_probes.remove(&key);
    true
}

fn close_precool_observation(
    state: &mut V3ProviderHealthState,
    permit: &V3ProviderHealthProbePermit,
) -> V3ProviderPrecoolObservationOutcome {
    if !released_precool_ownership(state, permit) {
        return V3ProviderPrecoolObservationOutcome::Superseded;
    }
    let key = permit.cooldown_key();
    let Some(history) = state.adaptive_history.get_mut(&key) else {
        // No health history means nothing to recover; the slot is released.
        return V3ProviderPrecoolObservationOutcome::Completed;
    };
    if history.score_generation != permit.expected_generation() {
        return V3ProviderPrecoolObservationOutcome::Superseded;
    }
    // Real probe recovery: close the failure window proven healthy by the
    // probe. Score, business success streak and generation stay untouched, so
    // no business receipt is fabricated and no cooldown is created or cleared.
    history.attempts = 0;
    history.failures = 0;
    history.failure_streak = 0;
    history.failure_fingerprint = None;
    history.probe_failure_count = 0;
    V3ProviderPrecoolObservationOutcome::Completed
}
