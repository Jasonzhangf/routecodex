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

pub(crate) enum V3RelayProviderAdmittedTargetResolution {
    Selected(V3AdmittedTargetSelection),
    Exhausted { attempted_candidates: Vec<String> },
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

fn v3_provider_concurrency_key(candidate: &V3TargetCandidate) -> String {
    format!("{}:{}", candidate.provider_id, candidate.auth_alias)
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
        Some(selected) => V3TargetSelectionAfterRescue::Selected(selected),
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
                        // Capacity is request-local selection state. It must not
                        // trigger health recovery probes or a capacity wait.
                        selection = select_v3_expanded_target_with_exhaustion_rescue(
                            manifest,
                            expanded.clone(),
                            failure_session_scope,
                            provider_health,
                            &excluded,
                            now_ms,
                            deterministic_sample,
                            false,
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
                &candidate.auth_alias,
                &candidate.model_id,
            );
            if !identities.insert(identity) {
                continue;
            }
            let rescue_permit = self
                .store
                .acquire_provider_cooldown_rescue_probe(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                )
                .map_err(|error| error.to_string())?;
            let permit = match rescue_permit {
                Some(permit) => Some(permit),
                None => self
                    .store
                    .acquire_provider_cooldown_probe_if_due(
                        &candidate.provider_id,
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
                let permit_provider_id = permit.provider_id().to_string();
                let permit_auth_alias = permit.auth_alias().map(str::to_string);
                let permit_model_id = permit.model_id().map(str::to_string);
                let cancellation = V3ProviderProbeCancellationGuard {
                    store: health.store.clone(),
                    provider_id: permit_provider_id.clone(),
                    auth_alias: permit_auth_alias.clone(),
                    model_id: permit_model_id.clone(),
                    expected_generation: permit.expected_generation(),
                };
                let result = match target {
                    Ok(Some(target)) => probe_v3_provider_global_target(target).await,
                    Ok(None) => Err(V3ProviderHealthProbeFailure::Internal(format!(
                        "provider cooldown rescue probe target missing for {provider_id}:{auth_alias}"
                    ))),
                    Err(error) => Err(V3ProviderHealthProbeFailure::Internal(error)),
                };
                let completion = match result {
                    Ok(()) => health
                        .store
                        .complete_provider_cooldown_probe_success_at_generation(
                            &permit_provider_id,
                            permit_auth_alias.as_deref(),
                            permit_model_id.as_deref(),
                            v3_relay_provider_policy_now_epoch_ms()?,
                            Some(permit.expected_generation()),
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
                            .complete_provider_cooldown_probe_failure_at_generation(
                                &permit_provider_id,
                                permit_auth_alias.as_deref(),
                                permit_model_id.as_deref(),
                                v3_relay_provider_policy_now_epoch_ms()?,
                                Some(permit.expected_generation()),
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
    let session_availability = provider_health.session_bound_availability(failure_session_scope);
    let initial_selection = select_v3_target_with_session_then_global(
        &target,
        expanded.clone(),
        &session_availability,
        provider_health,
        request_local_excluded_candidates,
        now_ms,
        0,
    );
    match initial_selection {
        Ok(selected) => {
            let selected_key = v3_relay_provider_candidate_key(&selected.candidate);
            let available_count = expanded
                .candidates
                .iter()
                .filter(|candidate| {
                    let key = v3_relay_provider_candidate_key(candidate);
                    !request_local_excluded_candidates.contains(&key)
                        && provider_health
                            .availability(
                                &candidate.provider_id,
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
                        .availability(
                            &candidate.provider_id,
                            Some(&candidate.auth_alias),
                            Some(&candidate.model_id),
                            now_ms,
                        )
                        .blocked_scopes
                        .iter()
                        .any(|scope| scope.contains("cooldown"))
            });
            let selected_tier = V3TargetInterpreter::route_tier_index_for_candidate(
                &selected.route,
                &selected.candidate,
            );
            let preceding_tier_candidates = if selected_tier == usize::MAX {
                Vec::new()
            } else {
                expanded
                    .candidates
                    .iter()
                    .filter(|candidate| {
                        let key = v3_relay_provider_candidate_key(candidate);
                        V3TargetInterpreter::route_tier_index_for_candidate(
                            &selected.route,
                            candidate,
                        ) < selected_tier
                            && !request_local_excluded_candidates.contains(&key)
                            && provider_health
                                .availability(
                                    &candidate.provider_id,
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
            // A later tier is selected only after its preceding tiers are
            // unavailable. Probe those cooled members before committing to the
            // later tier. Request-local failures stay excluded permanently.
            let rescue_candidates = if !preceding_tier_candidates.is_empty() {
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
            };
            if allow_exhaustion_rescue_probe && !rescue_candidates.is_empty() {
                if let Err(error) = provider_health
                    .run_cooldown_rescue_probes_for_candidates(manifest, &rescue_candidates, now_ms)
                    .await
                {
                    return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                        "V3ProviderCooldownRescueProbe",
                        "target_pre_exhaustion_rescue_probe_failed",
                        error,
                    ));
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
                match select_v3_target_with_session_then_global(
                    &target,
                    expanded.clone(),
                    &provider_health.session_bound_availability(failure_session_scope),
                    provider_health,
                    request_local_excluded_candidates,
                    retry_now_ms,
                    deterministic_sample,
                ) {
                    Ok(selected) => V3TargetSelectionAfterRescue::Selected(selected),
                    Err(exhausted) => V3TargetSelectionAfterRescue::Exhausted(exhausted),
                }
            } else {
                V3TargetSelectionAfterRescue::Selected(selected)
            }
        }
        Err(initial_exhaustion) => {
            // A complete eligible-pool exhaustion is terminal for THIS request.
            // It must not wait for, or resume on, later recovery. The independent
            // background probe owner restores admission for a NEW request only.
            V3TargetSelectionAfterRescue::Exhausted(initial_exhaustion)
        }
    }
}
