type V3PrecoolIdentity = routecodex_v3_provider_responses::V3ProviderCooldownProbeKey;

#[derive(Debug)]
struct V3DeferredHealthAction {
    ticket: crate::provider_action_gate::V3ProviderActionRecoveryTicket,
    observing: Option<u64>,
    /// Reasons of the business failures recorded while this identity was held
    /// for its declared observation. Each failure was counted into the store
    /// streak at deferral time; the hold itself is the observability substate
    /// that keeps the probe cadence alive and never hides the identity from
    /// the pool below the ladder threshold.
    reasons: Vec<Option<String>>,
    /// Store consecutive-failure streak of this identity after the most recent
    /// counted deferral. Snapshots report it instead of the number of reasons.
    counted_streak: u32,
}

struct V3PrecoolObservationGuard {
    health: V3ProviderFailureRuntimeHealth,
    identity: V3PrecoolIdentity,
    generation: u64,
    _observation_lease: crate::provider_action_gate::V3ProviderObservationLease,
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

/// Read-only snapshot of one exact identity currently held for its declared
/// pre-cool observation. Probe, cooldown and observation holds are cooldown
/// substates: they change visibility inside the pool and are never a request
/// admission gate. This snapshot exists so server observability can list the
/// holds; it carries no control state and grants no authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3PendingPrecoolObservation {
    pub provider_id: String,
    pub interface_id: String,
    pub auth_alias: Option<String>,
    pub model_id: Option<String>,
    /// Reason of the most recent unapplied deferred failure, if one was kept.
    pub reason: Option<String>,
    /// The store's consecutive-failure streak for this exact identity as of the
    /// most recent deferral. Every deferred business failure is counted
    /// immediately, so this is the business ladder position, not an
    /// observation count.
    pub consecutive_failures: u32,
    /// Observation generation currently in flight, if the hold is being
    /// observed right now.
    pub observing_generation: Option<u64>,
}

impl V3ProviderFailureRuntimeHealth {
    /// Snapshot every pending pre-cool observation hold. Pure read: it does
    /// not admit, release, advance or mutate any hold.
    pub fn pending_precool_observations(&self) -> Vec<V3PendingPrecoolObservation> {
        match self.precool.lock() {
            Ok(pending) => pending
                .iter()
                .map(|(identity, action)| {
                    V3PendingPrecoolObservation {
                        provider_id: identity.provider_id.clone(),
                        interface_id: identity.interface_id.clone(),
                        auth_alias: identity.auth_alias.clone(),
                        model_id: identity.model_id.clone(),
                        reason: action.reasons.last().cloned().flatten(),
                        consecutive_failures: action.counted_streak,
                        observing_generation: action.observing,
                    }
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

impl V3ProviderFailureRuntimeHealth {
    /// A pre-cool hold is the observability substate of an identity whose
    /// consecutive business failures are being counted. It deliberately does
    /// not change visibility: below the ladder threshold the identity stays
    /// routable, so its own failures keep counting, and only the store's
    /// committed cooldown hides it afterwards.
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
        if matches!(action.recovery, V3ProviderRecoveryKind::NotProviderHealth) {
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
        // v31: the ordinary request failure is counted immediately for the
        // complete identity through the counted action path. Below the ladder
        // threshold the store record stays available, so the identity remains
        // routable and its own failures keep counting; only a crossing commits
        // the 10s/30s/1h cooldown entry, and the hold is then released because
        // the store's cooldown pool owns that identity.
        let counted = self.store.record_provider_failure_action_for_interface(
            provider_id, interface_id, auth_alias.unwrap(), model_id.unwrap(), &late_action, now_ms,
        )?;
        if !counted.available {
            if let Some(previous) = pending.remove(&identity) {
                self.action_gate.record_success(previous.ticket.key())?;
            }
            record.state = "cooldown".into();
            record.failure_count = counted.failure_streak;
            record.cooldown_until_ms = counted.cooldown_until_ms;
            drop(pending);
            self.store.publish_availability_change();
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
                reasons: Vec::new(),
                counted_streak: counted.failure_streak,
            });
        entry.ticket = failure.recovery_ticket().clone();
        entry.reasons.push(reason.map(str::to_owned));
        entry.counted_streak = counted.failure_streak;
        record.state = "pre_cool_observation".into();
        record.failure_count = counted.failure_streak;
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
                    _observation_lease: admission,
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
                let (_, action) = classify_provider_probe_failure(error)?;
                // v31: a failed recovery probe advances only its own probe
                // cadence. It must not advance the business cooldown ladder,
                // because that ladder counts ordinary request failures, which
                // are already counted at deferral time. The hold therefore
                // stays in place to keep observing; it is released only when
                // the store's own committed cooldown already hides the
                // identity (for example the request streak crossed while the
                // observation was in flight).
                let committed = !self
                    .store
                    .availability_for_interface(
                        &identity.provider_id,
                        &identity.interface_id,
                        identity.auth_alias.as_deref(),
                        identity.model_id.as_deref(),
                        now_ms,
                    )
                    .available;
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
