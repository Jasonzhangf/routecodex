use super::*;
use crate::key_health::V3ProviderRateLimitProbeDisposition;

fn beijing_day(now_ms: u64) -> u64 {
    now_ms.saturating_add(8 * 3_600_000) / 86_400_000
}

pub(super) fn is_expired_day(
    state: &V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
) -> bool {
    state
        .adaptive_history
        .get(key)
        .and_then(|history| history.rate_limit_episode.as_ref())
        .and_then(|episode| episode.first_429_at_ms)
        .is_some_and(|first| beijing_day(now_ms) > beijing_day(first))
}

pub(super) fn reset_expired_day(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
) -> bool {
    if !is_expired_day(state, key, now_ms) {
        return false;
    }
    if let Some(history) = state.adaptive_history.get_mut(key) {
        history.rate_limit_episode = None;
        history.score_generation = history.score_generation.saturating_add(1);
    }
    if state
        .provider_cooldown_probes
        .get(key)
        .is_some_and(|probe| {
            probe.cooldown_cause == Some(V3ProviderCooldownFailureClass::RateLimit)
        })
    {
        state.provider_cooldown_probes.remove(key);
    }
    true
}

impl V3ProviderHealthStore {
    pub fn interrupt_session_rate_limit_streak_for_interface(
        &self,
        session: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
    ) -> Result<(), String> {
        let key = crate::provider_cooldown_probe::session_cooldown_probe_key_for_interface(
            session, provider_id, interface_id, Some(auth_alias), Some(model_id),
        );
        let mut state = self.state.write().map_err(|error| error.to_string())?;
        if let Some(episode) = state.adaptive_history.get_mut(&key)
            .and_then(|history| history.rate_limit_episode.as_mut())
        {
            episode.consecutive_429 = 0;
        }
        Ok(())
    }

    pub fn record_session_rate_limit_for_interface(
        &self,
        session: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let key = crate::provider_cooldown_probe::session_cooldown_probe_key_for_interface(
            session,
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let mut state = self.state.write().map_err(|error| error.to_string())?;
        if !state.health_disabled.contains(provider_id) {
            observe_rate_limit(&mut state, &key, now_ms, true);
        }
        let mut projection = key_health_projection(&state, &key, now_ms);
        let identity = crate::provider_cooldown_probe::provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        projection.recovery_success_revision = state
            .adaptive_history
            .get(&identity)
            .map_or(0, |history| history.recovery_success_revision);
        drop(state);
        self.publish_availability_change();
        Ok(projection)
    }

    /// Consume a real HTTP failure under its physical probe ownership. This
    /// changes only429 recovery policy, not business attempt/score counters.
    pub fn record_provider_rate_limit_probe_status_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        status: u16,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<V3ProviderRateLimitProbeDisposition, String> {
        let key = permit.cooldown_key();
        let mut state = self.state.write().map_err(|error| error.to_string())?;
        let owns = match permit.purpose() {
            V3ProviderProbePurpose::CooldownRecovery => state
                .provider_cooldown_probes
                .get(&key)
                .is_some_and(|probe| probe.active_probe == Some(permit.acquisition_id)),
            V3ProviderProbePurpose::PrecoolObservation
            | V3ProviderProbePurpose::StartupObservation => {
                state.precool_observation_probes.get(&key) == Some(&permit.acquisition_id)
            }
        };
        let generation = state
            .adaptive_history
            .get(&key)
            .map_or(0, |history| history.score_generation);
        if !owns || generation != permit.expected_generation() {
            probe_schedule::release_probe_acquisition(&mut state, permit);
            persist_cooldown_state(state);
            self.publish_availability_change();
            return Ok(V3ProviderRateLimitProbeDisposition::Superseded);
        }
        let has_episode = state
            .adaptive_history
            .get(&key)
            .is_some_and(|history| history.rate_limit_episode.is_some());
        let result = if status == 429 && !state.health_disabled.contains(&key.provider_id) {
            observe_rate_limit(&mut state, &key, now_ms, false);
            V3ProviderRateLimitProbeDisposition::Retained
        } else if has_episode {
            let history = state.adaptive_history.get_mut(&key).unwrap();
            let episode = history.rate_limit_episode.as_mut().unwrap();
            episode.first_429_at_ms = None;
            episode.last_429_at_ms = None;
            if episode.not_before_ms.is_none_or(|until| now_ms >= until) {
                history.rate_limit_episode = None;
            }
            // The old exclusion remains in place while this real HTTP failure
            // enters its own probe policy. Never publish an available interval.
            if let Some(probe) = state.provider_cooldown_probes.get_mut(&key) {
                probe.cooldown_cause = None;
                probe.long_probe_backoff = action.long_probe_backoff
                    || action.recovery == V3ProviderRecoveryKind::IrrecoverableGlobalCooldown;
            }
            V3ProviderRateLimitProbeDisposition::Reclassified
        } else {
            return Ok(V3ProviderRateLimitProbeDisposition::NotApplicable);
        };
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(result)
    }
}

/// Record an actual429 observation, independently of business failure scores.
pub(super) fn observe_rate_limit(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
    business_observation: bool,
) {
    reset_expired_day(state, key, now_ms);
    let new_minimum = {
        let history = state.adaptive_history.entry(key.clone()).or_default();
        if business_observation {
            history.score_generation = history.score_generation.saturating_add(1);
        }
        let episode = history
            .rate_limit_episode
            .get_or_insert_with(Default::default);
        episode.policy_version = 1;
        episode.first_429_at_ms.get_or_insert(now_ms);
        episode.last_429_at_ms = Some(episode.last_429_at_ms.unwrap_or(now_ms).max(now_ms));
        episode.consecutive_429 = episode.consecutive_429.saturating_add(1);
        episode.total_429 = episode.total_429.saturating_add(1);
        if episode.consecutive_429 >= 3 {
            episode.cooldown_duration_ms = if episode.total_429 >= 10 {
                3_600_000
            } else if episode.cooldown_duration_ms == 0 {
                10_000
            } else {
                episode.cooldown_duration_ms.saturating_mul(2)
            };
            let observed_at = episode.last_429_at_ms.unwrap_or(now_ms);
            let until = observed_at
                .saturating_add(episode.cooldown_duration_ms)
                .max(episode.not_before_ms.unwrap_or(0));
            episode.not_before_ms = Some(until);
            Some((until, observed_at))
        } else {
            None
        }
    };
    if let Some((until, observed_at)) = new_minimum {
        // A separate non-429 failure already owns this probe. Keep its
        // restriction and ladder; the 429 episode remains in typed history.
        if state
            .provider_cooldown_probes
            .get(key)
            .is_some_and(|probe| {
                probe.cooldown_cause != Some(V3ProviderCooldownFailureClass::RateLimit)
            })
        {
            return;
        }
        let advisory_probe = state
            .failure_policies
            .get(&key.provider_id)
            .is_some_and(|policy| policy.advisory_probe);
        upsert_provider_cooldown_probe_for_key(
            state,
            key,
            observed_at,
            until,
            until.saturating_sub(observed_at),
            false,
            advisory_probe,
        );
        if let Some(probe) = state.provider_cooldown_probes.get_mut(key) {
            probe.cooldown_cause = Some(V3ProviderCooldownFailureClass::RateLimit);
            let next_midnight = beijing_day(observed_at)
                .saturating_add(1)
                .saturating_mul(86_400_000)
                .saturating_sub(8 * 3_600_000);
            probe.next_probe_at_ms = Some(until.min(next_midnight));
        }
    }
}

/// A matching real business success ends the 429 episode.
pub(super) fn reset_on_business_success(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    _now_ms: u64,
) -> bool {
    let Some(history) = state.adaptive_history.get_mut(key) else {
        return true;
    };
    history.rate_limit_episode = None;
    true
}

pub(super) fn accept_qualified_probe_success(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    _now_ms: u64,
    qualified: bool,
) -> bool {
    let Some(history) = state.adaptive_history.get_mut(key) else {
        return true;
    };
    if history.rate_limit_episode.is_none() {
        return true;
    }
    if !qualified {
        return false;
    }
    history.rate_limit_episode = None;
    true
}
