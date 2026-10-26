pub(crate) struct V3AdmittedTargetSelection {
    pub(crate) selected: V3Target10ConcreteProviderSelected,
    pub(crate) admission: V3RuntimeProviderAdmission,
}

pub(crate) struct V3RuntimeProviderAdmission {
    controller: V3AdaptiveConcurrencyController,
    lease: Option<V3AdaptiveConcurrencyLease>,
}

impl V3RuntimeProviderAdmission {
    fn new(controller: V3AdaptiveConcurrencyController, lease: V3AdaptiveConcurrencyLease) -> Self {
        Self {
            controller,
            lease: Some(lease),
        }
    }

    pub(crate) fn into_lease(mut self) -> V3AdaptiveConcurrencyLease {
        self.lease
            .take()
            .expect("runtime provider admission lease must be present")
    }
}

impl Drop for V3RuntimeProviderAdmission {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            self.controller
                .release(lease.into_permit())
                .expect("runtime provider admission release must never underflow");
        }
    }
}

pub(crate) enum V3SynchronousTargetPlanningStep {
    Selected(V3Target10ConcreteProviderSelected),
    NeedPreExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        rescue_candidates: Vec<V3TargetCandidate>,
        request_local_excluded_candidates: BTreeSet<String>,
    },
    NeedExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        request_local_excluded_candidates: BTreeSet<String>,
    },
    Exhausted(V3TargetExhaustion),
    Failed(routecodex_v3_error::V3Error01SourceRaised),
    OperatorFault(crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault),
}

pub(crate) enum V3SynchronousTargetAdmissionStep {
    Selected {
        selected: V3AdmittedTargetSelection,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    NeedPreExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        rescue_candidates: Vec<V3TargetCandidate>,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    NeedExhaustionProbes {
        expanded: V3Target09CandidateSetExpanded,
        exhaustion: V3TargetExhaustion,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    Exhausted {
        exhaustion: V3TargetExhaustion,
        source: Option<routecodex_v3_error::V3Error01SourceRaised>,
    },
    Failed(routecodex_v3_error::V3Error01SourceRaised),
    OperatorFault(crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault),
}

pub(crate) async fn initiate_v3_target_pre_exhaustion_rescue_probes(
    provider_health: &V3ProviderFailureRuntimeHealth,
    manifest: &V3Config05ManifestPublished,
    candidates: &[V3TargetCandidate],
    now_ms: u64,
) -> Result<
    (),
    Result<
        routecodex_v3_error::V3Error01SourceRaised,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
> {
    let mut identities = BTreeSet::new();
    for candidate in candidates {
        if !identities.insert(v3_relay_provider_candidate_key(candidate)) {
            continue;
        }
        // Never send a real provider probe outside a declared availability
        // window: a cooled model whose free window has closed must not be
        // billed by a rescue probe.
        if !routecodex_v3_target::V3TargetInterpreter::candidate_in_availability_window(
            candidate, now_ms,
        ) {
            continue;
        }
        match provider_health
            .initiate_cooldown_rescue_probe(manifest, candidate, now_ms)
            .await
        {
            Ok(V3ProbeInitiation::Completed(completion)) => {
                let _ = completion;
            }
            Ok(
                V3ProbeInitiation::Initiated
                | V3ProbeInitiation::AlreadyOwned
                | V3ProbeInitiation::CapacityUnavailable
                | V3ProbeInitiation::OwnerUnavailable,
            ) => {}
            Err(error) => {
                return Err(target_resolution_source(
                    "V3ProviderCooldownRescueProbe",
                    "target_pre_exhaustion_rescue_probe_failed",
                    error,
                ));
            }
        }
    }
    Ok(())
}

pub(crate) struct V3SynchronousTargetPlanningInput<'a> {
    pub(crate) manifest: &'a V3Config05ManifestPublished,
    pub(crate) expanded: V3Target09CandidateSetExpanded,
    pub(crate) failure_session_scope: &'a V3ProviderFailureSessionScope,
    pub(crate) provider_health: &'a V3ProviderFailureRuntimeHealth,
    pub(crate) request_local_excluded_candidates: &'a BTreeSet<String>,
    pub(crate) request_local_busy_candidates: &'a BTreeSet<String>,
    pub(crate) now_ms: u64,
    pub(crate) deterministic_sample: u64,
    pub(crate) allow_exhaustion_rescue_probe: bool,
    pub(crate) preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    pub(crate) pre_exhaustion_probes_completed: bool,
    pub(crate) exhaustion_probes_completed: bool,
}

pub(crate) fn v3_provider_concurrency_key_parts(provider_id: &str, auth_alias: &str) -> String {
    format!("{provider_id}:{auth_alias}")
}

fn v3_provider_concurrency_key(candidate: &V3TargetCandidate) -> String {
    v3_provider_concurrency_key_parts(&candidate.provider_id, &candidate.auth_alias)
}

pub(crate) fn v3_pure_all_busy_exhaustion_source(
    expanded: &V3Target09CandidateSetExpanded,
    excluded: &BTreeSet<String>,
    busy: &BTreeSet<String>,
) -> Result<
    Option<routecodex_v3_error::V3Error01SourceRaised>,
    crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
> {
    let captured: BTreeSet<String> = expanded
        .candidates
        .iter()
        .map(v3_relay_provider_candidate_key)
        .collect();
    // Pure all-busy requires every captured candidate, and every request-local
    // exclusion, to be proven busy by capacity. Any other exclusion reason
    // makes the final exhaustion mixed.
    if captured.is_empty() || !captured.is_subset(busy) || !excluded.is_subset(busy) {
        return Ok(None);
    }
    crate::shared::direct_plain_error(
        V3ErrorSourceKind::TargetPoolExhausted,
        "V3Target10ConcreteProviderSelected",
        "provider_concurrency_busy",
        format!(
            "{} capacity-saturated candidates unavailable",
            captured.len()
        ),
    )
    .map(Some)
}

pub(crate) fn try_admit_v3_selected_target(
    selected: &V3Target10ConcreteProviderSelected,
) -> Result<Option<V3RuntimeProviderAdmission>, String> {
    let controller = V3AdaptiveConcurrencyController::process_shared();
    let capacity_key = v3_provider_concurrency_key(&selected.candidate);
    controller
        .ensure_initial_budget(&capacity_key, selected.candidate.initial_concurrency_budget)?;
    Ok(controller
        .try_acquire_business(&capacity_key)
        .map(|lease| V3RuntimeProviderAdmission::new(controller, lease)))
}

pub(crate) enum V3AdmitAfterRecovery {
    Admitted(V3RuntimeProviderAdmission),
    Busy,
    Failed(String),
}

pub(crate) fn admit_v3_selected_target_after_recovery(
    selected: &V3Target10ConcreteProviderSelected,
) -> V3AdmitAfterRecovery {
    match try_admit_v3_selected_target(selected) {
        Ok(Some(admission)) => V3AdmitAfterRecovery::Admitted(admission),
        Ok(None) => V3AdmitAfterRecovery::Busy,
        Err(reason) => V3AdmitAfterRecovery::Failed(reason),
    }
}

fn v3_rescue_candidates_for_selected(
    expanded: &V3Target09CandidateSetExpanded,
    provider_health: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
    selected: &V3Target10ConcreteProviderSelected,
) -> Vec<V3TargetCandidate> {
    let selected_key = v3_relay_provider_candidate_key(&selected.candidate);
    let available_count = expanded
        .candidates
        .iter()
        .filter(|candidate| {
            let key = v3_relay_provider_candidate_key(candidate);
            !request_local_excluded_candidates.contains(&key)
                && provider_health
                    .availability_for_interface(
                        &candidate.provider_id,
                        &candidate.interface_id,
                        Some(&candidate.auth_alias),
                        Some(&candidate.model_id),
                        now_ms,
                    )
                    .available
        })
        .count();
    let cooled_peer_exists = expanded.candidates.iter().any(|candidate| {
        let key = v3_relay_provider_candidate_key(candidate);
        key != selected_key
            && !request_local_excluded_candidates.contains(&key)
            && provider_health
                .availability_for_interface(
                    &candidate.provider_id,
                    &candidate.interface_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    now_ms,
                )
                .blocked_scopes
                .iter()
                .any(|scope| scope.contains("cooldown"))
    });
    let selected_tier =
        V3TargetInterpreter::route_tier_index_for_candidate(&selected.route, &selected.candidate);
    let preceding_tier_candidates = if selected_tier == usize::MAX {
        Vec::new()
    } else {
        expanded
            .candidates
            .iter()
            .filter(|candidate| {
                let key = v3_relay_provider_candidate_key(candidate);
                V3TargetInterpreter::route_tier_index_for_candidate(&selected.route, candidate)
                    < selected_tier
                    && !request_local_excluded_candidates.contains(&key)
                    && provider_health
                        .availability_for_interface(
                            &candidate.provider_id,
                            &candidate.interface_id,
                            Some(&candidate.auth_alias),
                            Some(&candidate.model_id),
                            now_ms,
                        )
                        .blocked_scopes
                        .iter()
                        .any(|scope| scope.contains("cooldown"))
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    // A later tier is selected only after its preceding tiers are unavailable.
    // Request-local failures stay excluded permanently.
    if !preceding_tier_candidates.is_empty() {
        preceding_tier_candidates
    } else if selected_tier == 0 && available_count == 1 && cooled_peer_exists {
        expanded
            .candidates
            .iter()
            .filter(|candidate| {
                !request_local_excluded_candidates
                    .contains(&v3_relay_provider_candidate_key(candidate))
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    }
}

pub(crate) fn step_v3_target_planning_sync(
    input: V3SynchronousTargetPlanningInput<'_>,
) -> V3SynchronousTargetPlanningStep {
    let V3SynchronousTargetPlanningInput {
        manifest: _manifest,
        expanded,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        request_local_busy_candidates,
        now_ms,
        deterministic_sample,
        allow_exhaustion_rescue_probe,
        preferred_selected,
        pre_exhaustion_probes_completed,
        exhaustion_probes_completed,
    } = input;
    let target = V3TargetInterpreter::default();

    if let Some(preferred) = preferred_selected {
        return V3SynchronousTargetPlanningStep::Selected(preferred);
    }

    let selected = if pre_exhaustion_probes_completed || exhaustion_probes_completed {
        match select_v3_target_with_session_then_global(
            &target,
            expanded.clone(),
            &provider_health.session_bound_availability(failure_session_scope),
            provider_health,
            request_local_excluded_candidates,
            now_ms,
            deterministic_sample,
        ) {
            Ok(selected) => selected,
            Err(exhausted) => return V3SynchronousTargetPlanningStep::Exhausted(exhausted),
        }
    } else {
        match select_v3_target_with_session_then_global(
            &target,
            expanded.clone(),
            &provider_health.session_bound_availability(failure_session_scope),
            provider_health,
            request_local_excluded_candidates,
            now_ms,
            0,
        ) {
            Ok(selected) => selected,
            Err(exhaustion) => {
                if !allow_exhaustion_rescue_probe {
                    return V3SynchronousTargetPlanningStep::Exhausted(exhaustion);
                }
                if !v3_exhaustion_is_cooldown_only(
                    &expanded,
                    request_local_excluded_candidates,
                    failure_session_scope,
                    provider_health,
                    now_ms,
                ) {
                    return V3SynchronousTargetPlanningStep::Exhausted(exhaustion);
                }
                return V3SynchronousTargetPlanningStep::NeedExhaustionProbes {
                    expanded,
                    exhaustion,
                    request_local_excluded_candidates: request_local_excluded_candidates.clone(),
                };
            }
        }
    };

    let candidate = selected;
    let rescue_candidates = v3_rescue_candidates_for_selected(
        &expanded,
        provider_health,
        request_local_excluded_candidates,
        now_ms,
        &candidate,
    );
    if allow_exhaustion_rescue_probe
        && !pre_exhaustion_probes_completed
        && !rescue_candidates.is_empty()
    {
        return V3SynchronousTargetPlanningStep::NeedPreExhaustionProbes {
            expanded,
            rescue_candidates,
            request_local_excluded_candidates: request_local_excluded_candidates.clone(),
        };
    }
    V3SynchronousTargetPlanningStep::Selected(candidate)
}

pub(crate) fn step_v3_target_planning_with_admission_sync(
    input: V3SynchronousTargetPlanningInput<'_>,
) -> V3SynchronousTargetAdmissionStep {
    let V3SynchronousTargetPlanningInput {
        manifest,
        expanded,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        request_local_busy_candidates,
        now_ms,
        deterministic_sample,
        allow_exhaustion_rescue_probe,
        preferred_selected,
        pre_exhaustion_probes_completed,
        exhaustion_probes_completed,
    } = input;
    let mut excluded = request_local_excluded_candidates.clone();
    let mut busy = request_local_busy_candidates.clone();
    let mut preferred = preferred_selected;
    let mut pre_exhaustion_probes_completed = pre_exhaustion_probes_completed;
    let mut exhaustion_probes_completed = exhaustion_probes_completed;
    loop {
        let step = step_v3_target_planning_sync(V3SynchronousTargetPlanningInput {
            manifest,
            expanded: expanded.clone(),
            failure_session_scope,
            provider_health,
            request_local_excluded_candidates: &excluded,
            request_local_busy_candidates: &busy,
            now_ms,
            deterministic_sample,
            allow_exhaustion_rescue_probe,
            preferred_selected: preferred.take(),
            pre_exhaustion_probes_completed,
            exhaustion_probes_completed,
        });
        match step {
            V3SynchronousTargetPlanningStep::Selected(selected) => {
                match try_admit_v3_selected_target(&selected) {
                    Ok(Some(admission)) => {
                        return V3SynchronousTargetAdmissionStep::Selected {
                            selected: V3AdmittedTargetSelection {
                                selected,
                                admission,
                            },
                            request_local_excluded_candidates: excluded,
                            request_local_busy_candidates: busy,
                        };
                    }
                    Ok(None) => {
                        let busy_key = v3_relay_provider_candidate_key(&selected.candidate);
                        excluded.insert(busy_key.clone());
                        busy.insert(busy_key);
                        pre_exhaustion_probes_completed = false;
                        exhaustion_probes_completed = false;
                        // Capacity excludes only this candidate. Preserve the
                        // caller's recovery policy for eligible cooled peers.
                    }
                    Err(reason) => {
                        return match target_resolution_source(
                            "V3Target10ConcreteProviderSelected",
                            "provider_concurrency_admission_invalid_budget",
                            reason,
                        ) {
                            Ok(source) => V3SynchronousTargetAdmissionStep::Failed(source),
                            Err(fault) => V3SynchronousTargetAdmissionStep::OperatorFault(fault),
                        };
                    }
                }
            }
            V3SynchronousTargetPlanningStep::NeedPreExhaustionProbes {
                expanded,
                rescue_candidates,
                mut request_local_excluded_candidates,
            } => {
                request_local_excluded_candidates.extend(excluded);
                return V3SynchronousTargetAdmissionStep::NeedPreExhaustionProbes {
                    expanded,
                    rescue_candidates,
                    request_local_excluded_candidates,
                    request_local_busy_candidates: busy,
                };
            }
            V3SynchronousTargetPlanningStep::NeedExhaustionProbes {
                expanded,
                exhaustion,
                mut request_local_excluded_candidates,
            } => {
                request_local_excluded_candidates.extend(excluded);
                return V3SynchronousTargetAdmissionStep::NeedExhaustionProbes {
                    expanded,
                    exhaustion,
                    request_local_excluded_candidates,
                    request_local_busy_candidates: busy,
                };
            }
            V3SynchronousTargetPlanningStep::Exhausted(exhausted) => {
                return match v3_pure_all_busy_exhaustion_source(&expanded, &excluded, &busy) {
                    Ok(source) => V3SynchronousTargetAdmissionStep::Exhausted {
                        exhaustion: exhausted,
                        source,
                    },
                    Err(fault) => V3SynchronousTargetAdmissionStep::OperatorFault(fault),
                };
            }
            V3SynchronousTargetPlanningStep::Failed(source) => {
                return V3SynchronousTargetAdmissionStep::Failed(source);
            }
            V3SynchronousTargetPlanningStep::OperatorFault(fault) => {
                return V3SynchronousTargetAdmissionStep::OperatorFault(fault);
            }
        }
    }
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn target_availability_generation(&self) -> u64 {
        self.store.availability_generation()
    }

    async fn run_cooldown_rescue_probes_for_candidates(
        &self,
        manifest: &V3Config05ManifestPublished,
        candidates: &[V3TargetCandidate],
        now_ms: u64,
    ) -> Result<bool, String> {
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
                    return Ok(true);
                };
                let permit_interface_id = permit.interface_id().to_string();
                let cancellation = V3ProviderProbeCancellationGuard {
                    store: health.store.clone(),
                    permit,
                };
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
                        return Ok(false);
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
                completion
            });
        }
        let mut completed_all = true;
        for result in futures_util::future::join_all(probes).await {
            completed_all &= result?;
        }
        Ok(completed_all)
    }

    pub(crate) async fn run_exhaustion_rescue_probes(
        &self,
        manifest: &V3Config05ManifestPublished,
        expanded: &V3Target09CandidateSetExpanded,
        now_ms: u64,
    ) -> Result<bool, String> {
        self.run_cooldown_rescue_probes_for_candidates(manifest, &expanded.candidates, now_ms)
            .await
    }
}

fn v3_exhaustion_is_cooldown_only(
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
