use super::*;
use crate::key_health::V3ProviderRateLimitProbeDisposition;

impl V3ProviderHealthStore {
    /// Compatibility entry for the retired elapsed-429 policy.
    ///
    /// The shared Store now owns all real provider failure counting. A probe
    /// status must remain with the normal probe completion path so this
    /// compatibility method cannot create, extend, reclassify, or clear a
    /// business cooldown.
    pub fn record_provider_rate_limit_probe_status_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        status: u16,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<V3ProviderRateLimitProbeDisposition, String> {
        let _ = action;
        let key = provider_cooldown_probe_key_for_interface(
            permit.provider_id(),
            permit.interface_id(),
            permit.auth_alias(),
            permit.model_id(),
        );
        let state = self.state.read().map_err(|error| error.to_string())?;
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
            return Ok(V3ProviderRateLimitProbeDisposition::Superseded);
        }
        drop(state);

        if permit.purpose() == V3ProviderProbePurpose::PrecoolObservation {
            if (200..=299).contains(&status) {
                self.complete_provider_precool_observation_with_permit(permit)
                    .map_err(|error| error.to_string())?;
            } else {
                self.cancel_provider_cooldown_probe(permit)
                    .map_err(|error| error.to_string())?;
            }
            return Ok(V3ProviderRateLimitProbeDisposition::NotApplicable);
        }

        if (200..=299).contains(&status) {
            let recovered = self
                .complete_provider_cooldown_probe_success_if_current_with_permit(permit, now_ms)
                .map_err(|error| error.to_string())?;
            return Ok(if recovered {
                V3ProviderRateLimitProbeDisposition::Reclassified
            } else {
                V3ProviderRateLimitProbeDisposition::Retained
            });
        }

        self.complete_provider_cooldown_probe_failure_with_permit(permit, now_ms)
            .map_err(|error| error.to_string())?;
        Ok(V3ProviderRateLimitProbeDisposition::Retained)
    }
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
