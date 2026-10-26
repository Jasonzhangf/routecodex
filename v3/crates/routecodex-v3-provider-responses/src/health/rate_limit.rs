use super::*;
use crate::key_health::V3ProviderRateLimitProbeDisposition;

impl V3ProviderHealthStore {
    /// Consume a real HTTP failure under its physical probe ownership. This
    /// changes only429 recovery policy, not business attempt/score counters.
    pub fn record_provider_rate_limit_probe_status_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        status: u16,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<V3ProviderRateLimitProbeDisposition, String> {
        let key = provider_cooldown_probe_key_for_interface(
            permit.provider_id(),
            permit.interface_id(),
            permit.auth_alias(),
            permit.model_id(),
        );
        let mut state = self.state.write().map_err(|error| error.to_string())?;
        let owns = match permit.purpose() {
            V3ProviderProbePurpose::CooldownRecovery => state
                .provider_cooldown_probes
                .get(&key)
                .is_some_and(|probe| probe.active_probe == Some(permit.acquisition_id)),
            V3ProviderProbePurpose::PrecoolObservation => {
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
            episode.probe_required = false;
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
    let policy = routecodex_v3_config::internal::v3_internal_rate_limit_recovery();
    let new_minimum = {
        let history = state.adaptive_history.entry(key.clone()).or_default();
        if business_observation {
            history.score_generation = history.score_generation.saturating_add(1);
        }
        let episode = history
            .rate_limit_episode
            .get_or_insert_with(Default::default);
        let first = *episode.first_429_at_ms.get_or_insert(now_ms);
        episode.last_429_at_ms = Some(episode.last_429_at_ms.unwrap_or(now_ms).max(now_ms));
        let span = episode.last_429_at_ms.unwrap().saturating_sub(first);
        if span >= policy.probe_required_after_ms {
            episode.probe_required = true;
        }
        if span >= policy.observation_window_ms && episode.not_before_ms.is_none() {
            let until = now_ms.saturating_add(policy.cooldown_ms);
            episode.not_before_ms = Some(until);
            Some(until)
        } else {
            None
        }
    };
    if let Some(until) = new_minimum {
        upsert_provider_cooldown_probe_with_interval(
            state,
            &key.provider_id,
            &key.interface_id,
            key.auth_alias.as_deref(),
            key.model_id.as_deref(),
            now_ms,
            until,
            V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
            false,
        );
        if let Some(probe) = state.provider_cooldown_probes.get_mut(key) {
            probe.cooldown_cause = Some(V3ProviderCooldownFailureClass::RateLimit);
        }
    }
}

/// Business success cannot substitute for a required probe or shorten a
/// committed minimum. It can reset an observation that is not probe-locked.
pub(super) fn reset_on_business_success(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
) -> bool {
    let Some(history) = state.adaptive_history.get_mut(key) else {
        return true;
    };
    let Some(episode) = history.rate_limit_episode.as_mut() else {
        return true;
    };
    if episode.probe_required {
        return false;
    }
    episode.first_429_at_ms = None;
    episode.last_429_at_ms = None;
    if episode.not_before_ms.is_some_and(|until| now_ms < until) {
        return false;
    }
    history.rate_limit_episode = None;
    true
}

pub(super) fn accept_qualified_probe_success(
    state: &mut V3ProviderHealthState,
    key: &V3ProviderCooldownProbeKey,
    now_ms: u64,
    qualified: bool,
) -> bool {
    let Some(history) = state.adaptive_history.get_mut(key) else {
        return true;
    };
    let Some(episode) = history.rate_limit_episode.as_mut() else {
        return true;
    };
    if !qualified {
        return false;
    }
    episode.first_429_at_ms = None;
    episode.last_429_at_ms = None;
    episode.probe_required = false;
    if let Some(not_before) = episode.not_before_ms.filter(|until| now_ms < *until) {
        if let Some(probe) = state.provider_cooldown_probes.get_mut(key) {
            probe.next_probe_at_ms = Some(not_before);
        }
        return false;
    }
    history.rate_limit_episode = None;
    true
}
