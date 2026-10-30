type V3PrecoolIdentity = routecodex_v3_provider_responses::V3ProviderCooldownProbeKey;

#[derive(Debug)]
struct V3DeferredProviderFailure {
    action: V3ProviderFailureAction,
    policy: Option<V3ProviderFailurePolicy>,
    scope: V3ProviderFailureSessionScope,
    reason: Option<String>,
}

#[derive(Debug)]
struct V3DeferredHealthAction {
    ticket: crate::provider_action_gate::V3ProviderActionRecoveryTicket,
    observing: Option<u64>,
    failures: Vec<V3DeferredProviderFailure>,
    applied: usize,
}

struct V3PrecoolObservationGuard {
    health: V3ProviderFailureRuntimeHealth,
    identity: V3PrecoolIdentity,
    generation: u64,
    _admission: crate::provider_action_gate::V3ProviderActionPermit,
}

impl Drop for V3PrecoolObservationGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.health.precool.lock() {
            if let Some(action) = pending.get_mut(&self.identity) {
                if action.observing == Some(self.generation) {
                    action.observing = None;
                }
            }
        }
    }
}

fn precool_identity(
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3PrecoolIdentity {
    V3PrecoolIdentity {
        provider_id: provider_id.into(),
        interface_id: interface_id.into(),
        auth_alias: auth_alias.map(str::to_owned),
        model_id: model_id.map(str::to_owned),
    }
}

impl V3ProviderFailureRuntimeHealth {
    fn apply_precool_availability(
        &self,
        projection: &mut V3ProviderAvailabilityProjection,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) {
        let identity = precool_identity(provider_id, interface_id, auth_alias, model_id);
        match self.precool.lock() {
            Ok(pending) if pending.contains_key(&identity) => {
                projection.available = false;
                projection
                    .blocked_scopes
                    .push("provider_pre_cool_observation".into());
            }
            Err(_) => {
                projection.available = false;
                projection
                    .blocked_scopes
                    .push("provider_pre_cool_control_unavailable".into());
            }
            _ => {}
        }
    }

    fn defer_provider_health_action(
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
        minimum_delay_ms: u64,
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
            let projection = self.store.record_provider_failure_action_for_interface(
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                action,
                self.observation_now_ms(now_ms),
            )?;
            record.state = if projection.available {
                "rate_limit_capacity_wait"
            } else {
                "rate_limit_cooldown"
            }
            .into();
            record.cooldown_until_ms = projection.cooldown_until_ms;
            if projection.cooldown {
                let mut pending = self.precool.lock().map_err(|error| error.to_string())?;
                if let Some(previous) = pending.remove(&precool_identity(
                    provider_id, interface_id, Some(auth_alias), Some(model_id),
                )) {
                    self.action_gate.record_success(previous.ticket.key())?;
                }
            }
            return Ok(record);
        }
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::NotProviderHealth
                | V3ProviderRecoveryKind::HealthNeutralTransient
        ) {
            return Ok(record);
        }
        if auth_alias.is_none() || model_id.is_none() {
            return Err(
                "provider observation requires a complete provider/interface/auth/model identity"
                    .into(),
            );
        }
        let identity = precool_identity(provider_id, interface_id, auth_alias, model_id);
        let mut pending = self.precool.lock().map_err(|error| error.to_string())?;
        let mut late_action = action.clone();
        if let Some(policy) = policy {
            late_action = V3ProviderFailureAction::recoverable("provider_failure");
            late_action.failure_fingerprint = action.failure_fingerprint.clone();
            late_action.failure_threshold = policy.failure_threshold;
            late_action.cooldown_ms = policy.cooldown_ms;
            late_action.long_probe_backoff = policy.long_probe_backoff;
        }
        if let Some(cooled) = self.store.record_provider_failure_action_if_cooled_for_interface(
            provider_id, interface_id, auth_alias.unwrap(), model_id.unwrap(), &late_action, now_ms,
        )? {
            // The failure is already retained by the typed Error event. Do
            // not shadow the active recovery owner; count it exactly once.
            if let Some(previous) = pending.remove(&identity) {
                self.action_gate.record_success(previous.ticket.key())?;
            }
            record.state = "cooldown".into();
            record.failure_count = cooled.failure_streak;
            record.cooldown_until_ms = cooled.cooldown_until_ms;
            return Ok(record);
        }
        let mut key =
            V3ProviderActionGateKey::new(scope, record.provider_key.clone(), "provider_pre_cool")?;
        // The enclosing RuntimeHealth belongs to one listener. Only the session
        // discriminator is shared; the real listener and identity remain intact.
        key.provider_scope.session_id = format!("pre-cool-observation:{}", record.provider_key);
        key.session_id = key.provider_scope.session_id.clone();
        let failure = self
            .action_gate
            .record_failure_with_minimum_delay(&key, minimum_delay_ms)?;
        let entry = pending
            .entry(identity)
            .or_insert_with(|| V3DeferredHealthAction {
                ticket: failure.recovery_ticket().clone(),
                observing: None,
                failures: Vec::new(),
                applied: 0,
            });
        entry.ticket = failure.recovery_ticket().clone();
        entry.failures.push(V3DeferredProviderFailure {
            action: action.clone(),
            policy,
            scope: scope.clone(),
            reason: reason.map(str::to_owned),
        });
        record.state = "pre_cool_observation".into();
        record.cooldown_until_ms = None;
        drop(pending);
        self.store.publish_availability_change();
        Ok(record)
    }

    fn precool_probe_keys(
        &self,
    ) -> Result<Vec<(String, String, Option<String>, Option<String>)>, String> {
        let pending = self.precool.lock().map_err(|error| error.to_string())?;
        Ok(pending
            .keys()
            .map(|key| {
                (
                    key.provider_id.clone(),
                    key.interface_id.clone(),
                    key.auth_alias.clone(),
                    key.model_id.clone(),
                )
            })
            .collect())
    }

    fn managed_precool_probe(
        &self,
        manifest: &V3Config05ManifestPublished,
        identity: V3PrecoolIdentity,
        slot: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Option<V3ManagedProbe>, String> {
        let (observation, cancellation) = {
            let mut pending = self.precool.lock().map_err(|error| error.to_string())?;
            let Some(action) = pending.get_mut(&identity) else {
                return Ok(None);
            };
            if action.observing.is_some() {
                return Ok(None);
            }
            let Some(admission) = self
                .action_gate
                .try_admit_observation(action.ticket.key())?
            else {
                return Ok(None);
            };
            let Some(permit) = self
                .store
                .acquire_provider_precool_probe_for_interface(
                    &identity.provider_id,
                    &identity.interface_id,
                    identity.auth_alias.as_deref(),
                    identity.model_id.as_deref(),
                )
                .map_err(|error| error.to_string())?
            else {
                return Ok(None);
            };
            action.observing = Some(action.ticket.generation());
            (
                V3PrecoolObservationGuard {
                    health: self.clone(),
                    identity: identity.clone(),
                    generation: action.ticket.generation(),
                    _admission: admission,
                },
                V3ProviderProbeCancellationGuard {
                    store: self.store.clone(),
                    permit,
                },
            )
        };
        let target = build_v3_provider_global_probe_target(
            manifest,
            &identity.provider_id,
            &identity.interface_id,
            identity.auth_alias.as_deref(),
            identity.model_id.as_deref(),
        );
        let health = self.clone();
        Ok(Some(Box::pin(async move {
            let _slot = slot;
            let execution = async {
                match target {
                    Ok(target) => probe_v3_provider_global_target_impl(target).await,
                    Err(error) => Err(V3ProviderHealthProbeFailure::Internal(error)),
                }
            };
            tokio::pin!(execution);
            let result = loop {
                let generation = health.target_availability_generation();
                let current = health
                    .store
                    .provider_precool_observation_permit_is_current(&cancellation.permit)
                    .map_err(|error| error.to_string())?;
                let pending_current = health
                    .precool
                    .lock()
                    .map_err(|error| error.to_string())?
                    .get(&identity)
                    .is_some_and(|action| action.ticket.generation() == observation.generation);
                if !current || !pending_current {
                    return Ok(V3ProbeCompletion::Superseded);
                }
                tokio::select! {
                    result = &mut execution => break result,
                    changed = health.wait_for_target_availability_change(generation) => { changed?; }
                }
            };
            let now_ms = health.observation_now_ms(v3_relay_provider_policy_now_epoch_ms()?);
            health.complete_precool_observation(&observation, &cancellation, result, now_ms)
        })))
    }

    fn complete_precool_observation(
        &self,
        observation: &V3PrecoolObservationGuard,
        cancellation: &V3ProviderProbeCancellationGuard,
        result: Result<(), V3ProviderHealthProbeFailure>,
        now_ms: u64,
    ) -> Result<V3ProbeCompletion, String> {
        let mut pending = self.precool.lock().map_err(|error| error.to_string())?;
        let identity = &observation.identity;
        let Some(entry) = pending.get_mut(identity) else {
            return Ok(V3ProbeCompletion::Superseded);
        };
        if entry.ticket.generation() != observation.generation {
            return Ok(V3ProbeCompletion::Superseded);
        }
        if !self
            .store
            .provider_precool_observation_permit_is_current(&cancellation.permit)
            .map_err(|error| error.to_string())?
        {
            return Ok(V3ProbeCompletion::Superseded);
        }
        match result {
            Ok(()) => {
                if self.store.complete_provider_precool_observation_with_permit(&cancellation.permit)
                    .map_err(|error| error.to_string())?
                    == routecodex_v3_provider_responses::key_health::V3ProviderPrecoolObservationOutcome::Superseded {
                    return Ok(V3ProbeCompletion::Superseded);
                }
                self.action_gate.record_success(entry.ticket.key())?;
                pending.remove(identity);
                self.store.publish_availability_change();
                Ok(V3ProbeCompletion::Recovered)
            }
            Err(V3ProviderHealthProbeFailure::ConcurrencyBusy) => {
                Ok(V3ProbeCompletion::CapacityUnavailable)
            }
            Err(V3ProviderHealthProbeFailure::Internal(error)) => Err(error),
            Err(V3ProviderHealthProbeFailure::Provider(error)) => {
                let (status, action) = classify_provider_probe_failure(error)?;
                if let Some(status) = status {
                    let disposition = self
                        .store
                        .record_provider_rate_limit_probe_status_with_permit(
                            &cancellation.permit,
                            status,
                            &action,
                            now_ms,
                        )?;
                    if disposition == routecodex_v3_provider_responses::V3ProviderRateLimitProbeDisposition::Superseded {
                        return Ok(V3ProbeCompletion::Superseded);
                    }
                    if status == 429 {
                        let cooled = !self
                            .store
                            .scheduling_projection_for_key_with_interface(
                                &identity.provider_id,
                                &identity.interface_id,
                                identity.auth_alias.as_deref().unwrap(),
                                identity.model_id.as_deref().unwrap(),
                                1,
                                1,
                                now_ms,
                            )?
                            .available;
                        if cooled {
                            // Hand the physical identity to the existing cooldown
                            // owner. Retaining a precool entry would shadow it.
                            self.action_gate.record_success(entry.ticket.key())?;
                            pending.remove(identity);
                        } else {
                            entry.ticket = self
                                .action_gate
                                .record_failure(entry.ticket.key())?
                                .recovery_ticket()
                                .clone();
                        }
                        self.store.publish_availability_change();
                        return Ok(V3ProbeCompletion::ProviderFailed);
                    }
                }
                let mut committed = false;
                while entry.applied < entry.failures.len() {
                    let failure = &entry.failures[entry.applied];
                    if let Some(policy) = failure.policy {
                        self.store
                            .record_provider_failure_in_session_with_policy_for_interface(
                                &failure.scope,
                                &identity.provider_id,
                                &identity.interface_id,
                                identity.auth_alias.as_deref(),
                                identity.model_id.as_deref(),
                                failure.reason.as_deref(),
                                failure.action.failure_fingerprint.clone(),
                                now_ms,
                                Some(policy),
                            )
                            .map_err(|error| error.to_string())?;
                    } else {
                        self.store.record_provider_failure_action_for_interface(
                            &identity.provider_id,
                            &identity.interface_id,
                            identity.auth_alias.as_deref().unwrap(),
                            identity.model_id.as_deref().unwrap(),
                            &failure.action,
                            now_ms,
                        )?;
                    }
                    entry.applied += 1;
                    committed |= !self
                        .store
                        .availability_for_session_for_interface(
                            &failure.scope,
                            &identity.provider_id,
                            &identity.interface_id,
                            identity.auth_alias.as_deref(),
                            identity.model_id.as_deref(),
                            now_ms,
                        )
                        .available;
                }
                eprintln!(
                    "provider observation failed: provider={} interface={} model={:?} action={action:?}",
                    identity.provider_id, identity.interface_id, identity.model_id
                );
                if committed {
                    self.action_gate.record_success(entry.ticket.key())?;
                    pending.remove(identity);
                }
                self.store.publish_availability_change();
                Ok(V3ProbeCompletion::ProviderFailed)
            }
        }
    }
}
