#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct V3CooldownRescueProbeOutcome {
    pub(crate) completed_all: bool,
    pub(crate) did_work: bool,
}

/// Whether the aggregate probe owner took custody of one rescue round.
///
/// The request path only reports custody; it never waits on the round. A round
/// that no owner accepted is dropped, never spawned: provider probe resource
/// lifetime belongs to the Server-owned aggregate, which cancels and joins what
/// it retains.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum V3CooldownRescueSubmission {
    /// The owner admitted the round into its managed probe queue.
    Initiated,
    /// The owner's probe capacity or queue is full; nothing was scheduled.
    CapacityUnavailable,
    /// No aggregate owner is registered or its sender is closed.
    OwnerUnavailable,
}

/// Upper bound for one background rescue round (control plane only).
///
/// v31 keeps requests independent of provider lifecycle: a request never waits
/// for a probe's cadence, a cooldown window or a recovery schedule, and the
/// rescue round is therefore never awaited by a request path. The round exists
/// because a captured target can exhaust while a cooled identity is the only
/// candidate that can answer: it changes pool visibility only, so a later
/// selection (or a later request) can use the identity again.
pub(crate) const V3_COOLDOWN_RESCUE_ROUND_BUDGET: std::time::Duration =
    std::time::Duration::from_millis(750);

/// Delay before a submitted rescue round starts probing.
///
/// A probe and a business request of the same complete
/// provider/interface/model/auth-key identity share one concurrency lease. The
/// request that submitted the round may itself send business to that identity
/// in the very next steps, so the control-plane observation waits out a short
/// grace period instead of contending for the lease its own request needs. The
/// grace is a scheduling detail of the observation; no request waits on it.
pub(crate) const V3_COOLDOWN_RESCUE_BACKGROUND_DELAY: std::time::Duration =
    std::time::Duration::from_millis(250);

pub(crate) fn v3_provider_concurrency_key_parts(provider_id: &str, auth_alias: &str) -> String {
    format!("{provider_id}:{auth_alias}")
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn target_availability_generation(&self) -> u64 {
        self.store.availability_generation()
    }

    pub(crate) async fn wait_for_target_availability_change(
        &self,
        observed_generation: u64,
    ) -> Result<u64, String> {
        self.store
            .wait_for_availability_change(observed_generation)
            .await
            .map_err(|error| error.to_string())
    }

    async fn run_cooldown_rescue_probes_for_candidates(
        &self,
        manifest: &V3Config05ManifestPublished,
        candidates: &[V3TargetCandidate],
        now_ms: u64,
    ) -> Result<V3CooldownRescueProbeOutcome, String> {
        let mut identities = BTreeSet::new();
        let mut probes = Vec::new();
        for candidate in candidates {
            let identity = (
                &candidate.provider_id,
                &candidate.interface_id,
                &candidate.auth_alias,
                &candidate.model_id,
            );
            if !identities.insert(identity) {
                continue;
            }
            // A cooled model whose availability window has closed must not be
            // reached by a real rescue probe outside its free window.
            if !routecodex_v3_target::V3TargetInterpreter::candidate_in_availability_window(
                candidate, now_ms,
            ) {
                continue;
            }
            let rescue_permit = self
                .store
                .acquire_provider_cooldown_rescue_probe_for_interface(
                    &candidate.provider_id,
                    &candidate.interface_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                )
                .map_err(|error| error.to_string())?;
            let permit = match rescue_permit {
                Some(permit) => Some(permit),
                None => self
                    .store
                    .acquire_provider_cooldown_probe_if_due_for_interface(
                        &candidate.provider_id,
                        &candidate.interface_id,
                        Some(&candidate.auth_alias),
                        Some(&candidate.model_id),
                        now_ms,
                    )
                    .map_err(|error| error.to_string())?,
            };
            let health = self.clone();
            let provider_id = candidate.provider_id.clone();
            let auth_alias = candidate.auth_alias.clone();
            let model_id = candidate.model_id.clone();
            let target = permit
                .as_ref()
                .map(|permit| {
                    build_v3_provider_global_probe_target(
                        manifest,
                        permit.provider_id(),
                        permit.interface_id(),
                        permit.auth_alias(),
                        permit.model_id(),
                    )
                })
                .transpose();
            probes.push(async move {
                let Some(permit) = permit else {
                    // Keep the candidate cooled while another request owns its
                    // probe, then let target selection use a later tier.
                    return Ok(V3CooldownRescueProbeOutcome { completed_all: true, did_work: false });
                };
                let permit_interface_id = permit.interface_id().to_string();
                let cancellation = V3ProviderProbeCancellationGuard {
                    store: health.store.clone(),
                    permit,
                };
                let did_work = matches!(&target, Ok(Some(_)));
                let result = match target {
                    Ok(Some(target)) => probe_v3_provider_global_target(target).await,
                    Ok(None) => Err(V3ProviderHealthProbeFailure::Internal(format!(
                        "provider cooldown rescue probe target missing for {provider_id}:{permit_interface_id}:{auth_alias}"
                    ))),
                    Err(error) => Err(V3ProviderHealthProbeFailure::Internal(error)),
                };
                let completion = match result {
                    Ok(()) => health
                        .store
                        .complete_provider_cooldown_probe_success_with_permit(
                            &cancellation.permit,
                            v3_relay_provider_policy_now_epoch_ms()?,
                        )
                        .map(|()| true)
                        .map_err(|error| error.to_string()),
                    Err(V3ProviderHealthProbeFailure::ConcurrencyBusy) => {
                        drop(cancellation);
                        return Ok(V3CooldownRescueProbeOutcome { completed_all: false, did_work: false });
                    }
                    Err(_error) => {
                        health
                            .store
                            .complete_provider_cooldown_probe_failure_with_permit(
                                &cancellation.permit,
                                v3_relay_provider_policy_now_epoch_ms()?,
                            )
                            .map_err(|store_error| store_error.to_string())?;
                        Ok(true)
                    }
                };
                drop(cancellation);
                completion.map(|completed_all| V3CooldownRescueProbeOutcome { completed_all, did_work })
            });
        }
        let mut outcome = V3CooldownRescueProbeOutcome { completed_all: true, did_work: false };
        for result in futures_util::future::join_all(probes).await {
            let result = result?;
            outcome.completed_all &= result.completed_all;
            outcome.did_work |= result.did_work;
        }
        Ok(outcome)
    }

    /// Run at most one bounded rescue round for an exhausted captured target.
    ///
    /// Returns `true` only when a probe was actually attempted. A probe that
    /// stalls past the round budget or deadline is cancelled (its cooldown and
    /// single-flight state stay with the store), so the caller's typed failure
    /// remains the truthful outcome instead of a fabricated recovery.
    pub(crate) async fn run_v3_bounded_cooldown_rescue_round(
        &self,
        manifest: &V3Config05ManifestPublished,
        expanded: &V3Target09CandidateSetExpanded,
        now_ms: u64,
        deadline: tokio::time::Instant,
    ) -> bool {
        let budget_deadline = tokio::time::Instant::now() + V3_COOLDOWN_RESCUE_ROUND_BUDGET;
        let round_deadline = if budget_deadline < deadline {
            budget_deadline
        } else {
            deadline
        };
        matches!(
            tokio::time::timeout_at(
                round_deadline,
                self.run_exhaustion_rescue_probes(manifest, expanded, now_ms),
            )
            .await,
            Ok(Ok(V3CooldownRescueProbeOutcome { did_work: true, .. }))
        )
    }

    /// Hand the bounded rescue round to the aggregate probe owner.
    ///
    /// Provider probe tasks are Server-owned: the aggregate probe lifecycle
    /// retains every managed probe, cancels what is still pending on shutdown and
    /// joins it, so a request path must never create a probe task of its own.
    /// Custody is therefore taken synchronously — owner lookup, a capacity slot
    /// and queue admission — and the return value reports whether the owner
    /// accepted the round. The caller never awaits it: the round cannot gate
    /// target selection, delay or replace a business send, retry an attempt or
    /// suppress a typed failure. Its only effect is the ordinary provider-health
    /// state that a later selection observes, so a request that submitted it
    /// keeps its own immediate outcome.
    pub(crate) fn submit_v3_background_cooldown_rescue_round(
        &self,
        manifest: &V3Config05ManifestPublished,
        expanded: &V3Target09CandidateSetExpanded,
    ) -> V3CooldownRescueSubmission {
        let owner = match self.probe_owner.lock() {
            Ok(owner) => owner.clone(),
            // No custody can be taken while the owner lock is poisoned. Nothing
            // is scheduled and the request outcome is untouched.
            Err(_) => return V3CooldownRescueSubmission::OwnerUnavailable,
        };
        // No aggregate registered (or it already closed its sender): there is no
        // owner to take the round, so it is dropped instead of spawned.
        let Some(owner) = owner.filter(|owner| !owner.sender.is_closed()) else {
            return V3CooldownRescueSubmission::OwnerUnavailable;
        };
        let Ok(slot) = owner.capacity.clone().try_acquire_owned() else {
            return V3CooldownRescueSubmission::CapacityUnavailable;
        };
        let health = self.clone();
        let manifest = manifest.clone();
        let expanded = expanded.clone();
        let work: V3ManagedProbe = Box::pin(async move {
            // The owner's slot is held for exactly the life of this round.
            let _slot = slot;
            tokio::time::sleep(V3_COOLDOWN_RESCUE_BACKGROUND_DELAY).await;
            // The observation reads the clock when it actually runs: a decision
            // made against the pre-grace timestamp could already be stale for a
            // cooldown that expired inside the grace.
            let Ok(now_ms) = v3_relay_provider_policy_now_epoch_ms() else {
                return Ok(V3ProbeCompletion::Superseded);
            };
            let _ = health
                .run_v3_bounded_cooldown_rescue_round(
                    &manifest,
                    &expanded,
                    now_ms,
                    tokio::time::Instant::now() + V3_COOLDOWN_RESCUE_ROUND_BUDGET,
                )
                .await;
            // The round is an observation only: it never reports a business
            // outcome and never becomes a health verdict of its own.
            Ok(V3ProbeCompletion::Superseded)
        });
        match owner.sender.try_send(work) {
            Ok(()) => V3CooldownRescueSubmission::Initiated,
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                V3CooldownRescueSubmission::CapacityUnavailable
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                V3CooldownRescueSubmission::OwnerUnavailable
            }
        }
    }

    pub(crate) async fn run_exhaustion_rescue_probes(
        &self,
        manifest: &V3Config05ManifestPublished,
        expanded: &V3Target09CandidateSetExpanded,
        now_ms: u64,
    ) -> Result<V3CooldownRescueProbeOutcome, String> {
        self.run_cooldown_rescue_probes_for_candidates(manifest, &expanded.candidates, now_ms)
            .await
    }
}

pub(crate) fn v3_exhaustion_is_cooldown_only(
    expanded: &V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: &BTreeSet<String>,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    now_ms: u64,
) -> bool {
    let availability = provider_health.session_bound_availability(failure_session_scope);
    let mut nonfailed_candidates = expanded.candidates.iter().filter(|candidate| {
        !request_local_excluded_candidates.contains(&v3_relay_provider_candidate_key(candidate))
    });
    let Some(first) = nonfailed_candidates.next() else {
        return false;
    };
    std::iter::once(first)
        .chain(nonfailed_candidates)
        .all(|candidate| {
            let projection = availability.availability_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                now_ms,
            );
            v3_availability_is_cooldown_recovery_only(&projection)
        })
}

fn v3_availability_is_cooldown_recovery_only(
    projection: &V3ProviderAvailabilityProjection,
) -> bool {
    !projection.available
        && projection.blocked_scopes.iter().all(|scope| {
            scope == "provider_cooldown_probe_pending"
                || scope.starts_with(&format!("auth_key:{}:", projection.provider_id))
        })
        && projection
            .blocked_scopes
            .iter()
            .any(|scope| scope == "provider_cooldown_probe_pending")
}
