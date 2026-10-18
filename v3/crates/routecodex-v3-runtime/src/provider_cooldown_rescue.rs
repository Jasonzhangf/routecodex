pub(crate) enum V3TargetSelectionAfterRescue {
    Selected(V3Target10ConcreteProviderSelected),
    Exhausted(V3TargetExhaustion),
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

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

pub(crate) enum V3AdmittedTargetSelectionAfterRescue {
    Selected(V3AdmittedTargetSelection),
    Exhausted(V3TargetExhaustion),
    Failed(routecodex_v3_error::V3Error01SourceRaised),
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
}

pub(crate) enum V3SynchronousTargetAdmissionStep {
    Selected {
        selected: V3AdmittedTargetSelection,
        request_local_excluded_candidates: BTreeSet<String>,
    },
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
}

pub(crate) async fn initiate_v3_target_pre_exhaustion_rescue_probes(
    provider_health: &V3ProviderFailureRuntimeHealth,
    manifest: &V3Config05ManifestPublished,
    candidates: &[V3TargetCandidate],
    now_ms: u64,
) -> Result<(), routecodex_v3_error::V3Error01SourceRaised> {
    let mut identities = BTreeSet::new();
    for candidate in candidates {
        if !identities.insert(v3_relay_provider_candidate_key(candidate)) {
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
    pub(crate) now_ms: u64,
    pub(crate) deterministic_sample: u64,
    pub(crate) allow_exhaustion_rescue_probe: bool,
    pub(crate) preferred_selected: Option<V3Target10ConcreteProviderSelected>,
    pub(crate) pre_exhaustion_probes_completed: bool,
    pub(crate) exhaustion_probes_completed: bool,
}

pub(crate) enum V3RelayProviderAdmittedTargetResolution {
    Selected(V3AdmittedTargetSelection),
    Exhausted { attempted_candidates: Vec<String> },
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

pub(crate) fn v3_provider_concurrency_key_parts(provider_id: &str, auth_alias: &str) -> String {
    format!("{provider_id}:{auth_alias}")
}

fn v3_provider_concurrency_key(candidate: &V3TargetCandidate) -> String {
    v3_provider_concurrency_key_parts(&candidate.provider_id, &candidate.auth_alias)
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
        now_ms,
        deterministic_sample,
        allow_exhaustion_rescue_probe,
        preferred_selected,
        pre_exhaustion_probes_completed,
        exhaustion_probes_completed,
    } = input;
    let mut excluded = request_local_excluded_candidates.clone();
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
                        };
                    }
                    Ok(None) => {
                        excluded.insert(v3_relay_provider_candidate_key(&selected.candidate));
                        pre_exhaustion_probes_completed = false;
                        exhaustion_probes_completed = false;
                        // Capacity excludes only this candidate. Preserve the
                        // caller's recovery policy for eligible cooled peers.
                    }
                    Err(reason) => {
                        return V3SynchronousTargetAdmissionStep::Failed(target_resolution_source(
                            "V3Target10ConcreteProviderSelected",
                            "provider_concurrency_admission_invalid_budget",
                            reason,
                        ));
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
                };
            }
            V3SynchronousTargetPlanningStep::Exhausted(exhausted) => {
                return V3SynchronousTargetAdmissionStep::Exhausted(exhausted);
            }
            V3SynchronousTargetPlanningStep::Failed(source) => {
                return V3SynchronousTargetAdmissionStep::Failed(source);
            }
        }
    }
}

pub(crate) async fn select_v3_expanded_target_with_admission_rescue(
    manifest: &V3Config05ManifestPublished,
    expanded: V3Target09CandidateSetExpanded,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    allow_exhaustion_rescue_probe: bool,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
) -> V3AdmittedTargetSelectionAfterRescue {
    let mut excluded = request_local_excluded_candidates.clone();
    let mut selection = match preferred_selected {
        Some(_) => {
            let step = step_v3_target_planning_sync(V3SynchronousTargetPlanningInput {
                manifest,
                expanded: expanded.clone(),
                failure_session_scope,
                provider_health,
                request_local_excluded_candidates: &excluded,
                now_ms,
                deterministic_sample,
                allow_exhaustion_rescue_probe,
                preferred_selected,
                pre_exhaustion_probes_completed: false,
                exhaustion_probes_completed: false,
            });
            match step {
                V3SynchronousTargetPlanningStep::Selected(selected) => {
                    V3TargetSelectionAfterRescue::Selected(selected)
                }
                V3SynchronousTargetPlanningStep::Exhausted(exhausted) => {
                    V3TargetSelectionAfterRescue::Exhausted(exhausted)
                }
                V3SynchronousTargetPlanningStep::Failed(source) => {
                    V3TargetSelectionAfterRescue::Failed(source)
                }
                V3SynchronousTargetPlanningStep::NeedPreExhaustionProbes { .. }
                | V3SynchronousTargetPlanningStep::NeedExhaustionProbes { .. } => {
                    unreachable!("preferred target planning cannot need rescue probes")
                }
            }
        }
        None => {
            select_v3_expanded_target_with_exhaustion_rescue(
                manifest,
                expanded.clone(),
                failure_session_scope,
                provider_health,
                request_local_excluded_candidates,
                now_ms,
                deterministic_sample,
                allow_exhaustion_rescue_probe,
            )
            .await
        }
    };
    loop {
        match selection {
            V3TargetSelectionAfterRescue::Selected(selected) => {
                match try_admit_v3_selected_target(&selected) {
                    Ok(Some(admission)) => {
                        return V3AdmittedTargetSelectionAfterRescue::Selected(
                            V3AdmittedTargetSelection {
                                selected,
                                admission,
                            },
                        );
                    }
                    Ok(None) => {
                        excluded.insert(v3_relay_provider_candidate_key(&selected.candidate));
                        // Capacity excludes only this candidate. Preserve the
                        // caller's recovery policy for eligible cooled peers;
                        // never wait for the full candidate's capacity.
                        selection = select_v3_expanded_target_with_exhaustion_rescue(
                            manifest,
                            expanded.clone(),
                            failure_session_scope,
                            provider_health,
                            &excluded,
                            now_ms,
                            deterministic_sample,
                            allow_exhaustion_rescue_probe,
                        )
                        .await;
                    }
                    Err(reason) => {
                        return V3AdmittedTargetSelectionAfterRescue::Failed(
                            build_v3_error_01_source_raised(
                                V3ErrorSourceKind::RuntimeFailure,
                                "V3Target10ConcreteProviderSelected",
                                "provider_concurrency_admission_invalid_budget",
                                reason,
                            ),
                        )
                    }
                }
            }
            V3TargetSelectionAfterRescue::Exhausted(exhausted) => {
                return V3AdmittedTargetSelectionAfterRescue::Exhausted(exhausted);
            }
            V3TargetSelectionAfterRescue::Failed(source) => {
                return V3AdmittedTargetSelectionAfterRescue::Failed(source);
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

pub(crate) async fn resolve_v3_relay_target_outcome_with_admission_rescue(
    input: V3RelayProviderTargetResolutionInput<'_>,
    allow_exhaustion_rescue_probe: bool,
    preferred_selected: Option<V3Target10ConcreteProviderSelected>,
) -> V3RelayProviderAdmittedTargetResolution {
    let expanded = match build_v3_relay_target_candidates(&input) {
        Ok(expanded) => expanded,
        Err(V3RelayProviderTargetResolution::Selected(_)) => {
            unreachable!("target candidate expansion cannot return a selected target")
        }
        Err(V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates,
        }) => {
            return V3RelayProviderAdmittedTargetResolution::Exhausted {
                attempted_candidates,
            }
        }
        Err(V3RelayProviderTargetResolution::Failed(source)) => {
            return V3RelayProviderAdmittedTargetResolution::Failed(source)
        }
    };
    match select_v3_expanded_target_with_admission_rescue(
        input.manifest,
        expanded,
        input.failure_session_scope,
        input.provider_health,
        input.request_local_excluded_candidates,
        input.now_ms,
        input.deterministic_sample,
        allow_exhaustion_rescue_probe,
        preferred_selected,
    )
    .await
    {
        V3AdmittedTargetSelectionAfterRescue::Selected(selected) => {
            V3RelayProviderAdmittedTargetResolution::Selected(selected)
        }
        V3AdmittedTargetSelectionAfterRescue::Exhausted(exhausted) => {
            V3RelayProviderAdmittedTargetResolution::Exhausted {
                attempted_candidates: exhausted.attempted_candidates,
            }
        }
        V3AdmittedTargetSelectionAfterRescue::Failed(source) => {
            V3RelayProviderAdmittedTargetResolution::Failed(source)
        }
    }
}

pub(crate) async fn select_v3_expanded_target_with_exhaustion_rescue(
    manifest: &V3Config05ManifestPublished,
    expanded: V3Target09CandidateSetExpanded,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    allow_exhaustion_rescue_probe: bool,
) -> V3TargetSelectionAfterRescue {
    let target = V3TargetInterpreter::default();
    let initial_step = step_v3_target_planning_sync(V3SynchronousTargetPlanningInput {
        manifest,
        expanded: expanded.clone(),
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        now_ms,
        deterministic_sample,
        allow_exhaustion_rescue_probe,
        preferred_selected: None,
        pre_exhaustion_probes_completed: false,
        exhaustion_probes_completed: false,
    });
    let initial_exhaustion = match initial_step {
        V3SynchronousTargetPlanningStep::Selected(selected) => {
            return V3TargetSelectionAfterRescue::Selected(selected);
        }
        V3SynchronousTargetPlanningStep::NeedPreExhaustionProbes {
            rescue_candidates, ..
        } => {
            if let Err(source) = initiate_v3_target_pre_exhaustion_rescue_probes(
                provider_health,
                manifest,
                &rescue_candidates,
                now_ms,
            )
            .await
            {
                return V3TargetSelectionAfterRescue::Failed(source);
            }
            let retry_now_ms = match v3_relay_provider_policy_now_epoch_ms() {
                Ok(now_ms) => now_ms,
                Err(error) => {
                    return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                        "V3ProviderCooldownRescueProbe",
                        "target_pre_exhaustion_rescue_clock_failed",
                        error,
                    ))
                }
            };
            return match select_v3_target_with_session_then_global(
                &target,
                expanded,
                &provider_health.session_bound_availability(failure_session_scope),
                provider_health,
                request_local_excluded_candidates,
                retry_now_ms,
                deterministic_sample,
            ) {
                Ok(selected) => V3TargetSelectionAfterRescue::Selected(selected),
                Err(exhausted) => V3TargetSelectionAfterRescue::Exhausted(exhausted),
            };
        }
        V3SynchronousTargetPlanningStep::NeedExhaustionProbes { exhaustion, .. } => exhaustion,
        V3SynchronousTargetPlanningStep::Exhausted(exhausted) => {
            return V3TargetSelectionAfterRescue::Exhausted(exhausted);
        }
        V3SynchronousTargetPlanningStep::Failed(source) => {
            return V3TargetSelectionAfterRescue::Failed(source);
        }
    };
    if !allow_exhaustion_rescue_probe {
        return V3TargetSelectionAfterRescue::Exhausted(initial_exhaustion);
    }
    loop {
        let retry_now_ms = match v3_relay_provider_policy_now_epoch_ms() {
            Ok(now_ms) => now_ms,
            Err(error) => {
                return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                    "V3ProviderCooldownRescueProbe",
                    "target_exhaustion_rescue_clock_failed",
                    error,
                ))
            }
        };
        let observed_generation = provider_health.store.availability_generation();
        let retry_availability = provider_health.session_bound_availability(failure_session_scope);
        let exhaustion = match select_v3_target_with_session_then_global(
            &target,
            expanded.clone(),
            &retry_availability,
            provider_health,
            request_local_excluded_candidates,
            retry_now_ms,
            0,
        ) {
            Ok(selected) => return V3TargetSelectionAfterRescue::Selected(selected),
            Err(exhausted) => exhausted,
        };
        if provider_health.store.availability_generation() != observed_generation {
            continue;
        }
        if !v3_exhaustion_is_cooldown_only(
            &expanded,
            request_local_excluded_candidates,
            failure_session_scope,
            provider_health,
            retry_now_ms,
        ) {
            return V3TargetSelectionAfterRescue::Exhausted(exhaustion);
        }
        let rescue_probes_completed = match provider_health
            .run_exhaustion_rescue_probes(manifest, &expanded, retry_now_ms)
            .await
        {
            Ok(completed) => completed,
            Err(error) => {
                return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                    "V3ProviderCooldownRescueProbe",
                    "target_exhaustion_rescue_probe_failed",
                    error,
                ));
            }
        };
        if !rescue_probes_completed {
            return V3TargetSelectionAfterRescue::Exhausted(exhaustion);
        }
        // This request gets one recovery pass. Future scheduled probes own
        // provider recovery independently; an exhausted request has no business
        // response and must reach the existing internal exhaustion disposition.
        let after_probe_ms = match v3_relay_provider_policy_now_epoch_ms() {
            Ok(now_ms) => now_ms,
            Err(error) => {
                return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                    "V3ProviderCooldownRescueProbe",
                    "target_exhaustion_rescue_clock_failed",
                    error,
                ))
            }
        };
        return match select_v3_target_with_session_then_global(
            &target,
            expanded,
            &provider_health.session_bound_availability(failure_session_scope),
            provider_health,
            request_local_excluded_candidates,
            after_probe_ms,
            deterministic_sample,
        ) {
            Ok(selected) => V3TargetSelectionAfterRescue::Selected(selected),
            Err(exhausted) => V3TargetSelectionAfterRescue::Exhausted(exhausted),
        };
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
