#[cfg(test)]
type V3PrecoolIdentity = routecodex_v3_provider_responses::V3ProviderCooldownProbeKey;

#[cfg(test)]
fn precool_identity(
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3PrecoolIdentity {
    V3PrecoolIdentity {
        scope: routecodex_v3_provider_responses::V3ProviderCooldownHealthScope::Identity,
        provider_id: provider_id.into(),
        interface_id: interface_id.into(),
        auth_alias: auth_alias.map(str::to_owned),
        model_id: model_id.map(str::to_owned),
    }
}

#[cfg(test)]
fn session_precool_identity(
    scope: &V3ProviderFailureSessionScope,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3PrecoolIdentity {
    let mut identity = precool_identity(provider_id, interface_id, auth_alias, model_id);
    identity.scope = routecodex_v3_provider_responses::V3ProviderCooldownHealthScope::from_session(scope);
    identity
}

impl V3ProviderFailureRuntimeHealth {
    fn record_provider_health_action_immediately(
        &self,
        scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
        action: &V3ProviderFailureAction,
        policy: Option<V3ProviderFailurePolicy>,
    ) -> Result<V3ProviderFailureRecord, String> {
        let provider_key = v3_relay_provider_candidate_key_parts(
            provider_id,
            Some(interface_id),
            auth_alias,
            model_id,
        );
        let mut record = V3ProviderFailureRecord {
            scope_label: provider_key.clone(),
            provider_key,
            state: "healthy".into(),
            failure_count: 0,
            cooldown_until_ms: None,
            recovery_success_revision: None,
            reason: reason.map(str::to_owned),
        };
        if action
            .failure_fingerprint
            .as_ref()
            .is_some_and(|failure| failure.http_status == 429)
        {
            let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) else {
                return Err(
                    "429 observation requires a complete provider/interface/auth/model identity"
                        .into(),
                );
            };
            let projection = self.store.record_session_rate_limit_for_interface(
                scope,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                self.observation_now_ms(now_ms),
            )?;
            record.state = if projection.available {
                "rate_limit_capacity_wait"
            } else {
                "rate_limit_cooldown"
            }
            .into();
            record.cooldown_until_ms = projection.cooldown_until_ms;
            record.recovery_success_revision = Some(projection.recovery_success_revision);
            return Ok(record);
        }
        if action.failure_fingerprint.as_ref().is_some_and(|failure| failure.http_status != 429) {
            if let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) {
                self.store.interrupt_session_rate_limit_streak_for_interface(
                    scope, provider_id, interface_id, auth_alias, model_id,
                )?;
            }
        }
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::NotProviderHealth
                | V3ProviderRecoveryKind::HealthNeutralTransient
        ) {
            return Ok(record);
        }
        let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) else {
            return Err("provider observation requires a complete provider/interface/auth/model identity".into());
        };
        if let Some(policy) = policy {
            return self.store.record_provider_failure_in_session_with_policy_for_interface(
                scope, provider_id, interface_id, Some(auth_alias), Some(model_id), reason,
                action.failure_fingerprint.clone(), now_ms, Some(policy),
            ).map_err(|error| error.to_string());
        }
        let projection = self.store.record_provider_failure_action_for_interface(
            provider_id, interface_id, auth_alias, model_id, action, now_ms,
        )?;
        record.state = if projection.cooldown { "cooldown" } else { "healthy" }.into();
        record.failure_count = projection.failure_streak;
        record.cooldown_until_ms = projection.cooldown_until_ms;
        record.recovery_success_revision = Some(projection.recovery_success_revision);
        Ok(record)
    }

}
