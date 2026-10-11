use super::{persistence, V3ProviderHealthError, V3ProviderHealthStore};
use crate::key_health::V3ProviderHealthProbePermit;
use crate::provider_cooldown_probe::resolve_provider_cooldown_probe_key_for_interface;
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
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        Ok(state
            .provider_cooldown_probes
            .iter()
            .filter(|(_, probe_state)| {
                !probe_state.probe_in_flight
                    && probe_state.blocked_until_ms.is_some()
                    && (startup
                        || probe_state
                            .next_probe_at_ms
                            .is_some_and(|next_probe_at_ms| next_probe_at_ms <= now_ms))
            })
            .map(|(key, probe_state)| {
                (
                    key.provider_id.clone(),
                    key.interface_id.clone(),
                    key.auth_alias.clone(),
                    probe_state.probe_model_id.clone(),
                )
            })
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
            .filter(|probe_state| !probe_state.probe_in_flight)
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
                    && (probe_state.probe_in_flight
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
        )
    }

    pub(super) fn acquire_provider_cooldown_probe_at_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        due_at_or_before_ms: Option<u64>,
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
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(&key) else {
            return Ok(None);
        };
        if probe_state.probe_in_flight
            || probe_state.blocked_until_ms.is_none()
            || probe_state.next_probe_at_ms.is_none()
            || due_at_or_before_ms.is_some_and(|now_ms| {
                probe_state
                    .next_probe_at_ms
                    .is_some_and(|next_probe_at_ms| next_probe_at_ms > now_ms)
            })
        {
            return Ok(None);
        }
        probe_state.probe_in_flight = true;
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
        )))
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
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(&key) else {
            return Ok(None);
        };
        if probe_state.probe_in_flight || probe_state.rescue_probe_attempted {
            return Ok(None);
        }
        probe_state.probe_in_flight = true;
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
        )))
    }

    /// Cancel an abandoned probe without touching a newer cooldown
    /// generation. The owner calls this from a cancellation guard when the
    /// request or managed probe task is dropped before completion.
    pub fn cancel_provider_cooldown_probe_at_generation(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        expected_generation: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.cancel_provider_cooldown_probe_at_generation_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            expected_generation,
        )
    }

    pub fn cancel_provider_cooldown_probe_at_generation_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        expected_generation: u64,
    ) -> Result<(), V3ProviderHealthError> {
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
        let current_generation = state
            .adaptive_history
            .get(&key)
            .map_or(0, |history| history.score_generation);
        if current_generation != expected_generation {
            return Ok(());
        }
        if let Some(probe_state) = state
            .provider_cooldown_probes
            .get_mut(&key)
            .filter(|probe_state| probe_state.probe_in_flight)
        {
            probe_state.probe_in_flight = false;
            persist_cooldown_state(state);
            self.publish_availability_change();
        }
        Ok(())
    }
}
