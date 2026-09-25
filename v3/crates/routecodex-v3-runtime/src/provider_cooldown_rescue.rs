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
    controller.ensure_initial_budget(
        &capacity_key,
        selected.candidate.initial_concurrency_budget,
    )?;
    Ok(controller.try_acquire_business(&capacity_key).map(|lease| {
        V3RuntimeProviderAdmission::new(controller, lease)
    }))
}

fn v3_provider_busy_target_exhaustion(
    expanded: &V3Target09CandidateSetExpanded,
    busy_candidates: &BTreeSet<String>,
) -> V3TargetExhaustion {
    V3TargetExhaustion {
        route: Box::new(expanded.route.clone()),
        attempted_candidates: expanded
            .candidates
            .iter()
            .filter_map(|candidate| {
                let key = v3_relay_provider_candidate_key(candidate);
                busy_candidates.contains(&key).then(|| {
                    format!(
                        "{}:{}:{}:concurrency_busy",
                        candidate.provider_id, candidate.auth_alias, candidate.model_id
                    )
                })
            })
            .collect(),
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
    reselect_busy_candidate: bool,
) -> V3AdmittedTargetSelectionAfterRescue {
    let controller = V3AdaptiveConcurrencyController::process_shared();
    let mut busy_candidates = BTreeSet::<String>::new();
    let mut busy_selected_candidates =
        BTreeMap::<String, (V3Target10ConcreteProviderSelected, String)>::new();
    let mut preferred_selected = preferred_selected;
    loop {
        let mut exclusions = request_local_excluded_candidates.clone();
        exclusions.extend(busy_candidates.iter().cloned());
        let selection = match preferred_selected.take() {
            Some(selected) => V3TargetSelectionAfterRescue::Selected(selected),
            None => {
                select_v3_expanded_target_with_exhaustion_rescue(
                    manifest,
                    expanded.clone(),
                    failure_session_scope,
                    provider_health,
                    &exclusions,
                    now_ms,
                    deterministic_sample,
                    allow_exhaustion_rescue_probe,
                )
                .await
            }
        };
        match selection {
            V3TargetSelectionAfterRescue::Selected(selected) => {
                let capacity_key = v3_provider_concurrency_key(&selected.candidate);
                if let Err(reason) = controller.ensure_initial_budget(
                    &capacity_key,
                    selected.candidate.initial_concurrency_budget,
                ) {
                    return V3AdmittedTargetSelectionAfterRescue::Failed(
                        build_v3_error_01_source_raised(
                            V3ErrorSourceKind::RuntimeFailure,
                            "V3Target10ConcreteProviderSelected",
                            "provider_concurrency_admission_invalid_budget",
                            reason,
                        ),
                    );
                }
                if let Some(admission) = controller.try_acquire_business(&capacity_key) {
                    return V3AdmittedTargetSelectionAfterRescue::Selected(
                        V3AdmittedTargetSelection {
                            selected,
                            admission: V3RuntimeProviderAdmission::new(
                                controller.clone(),
                                admission,
                            ),
                        },
                    );
                }
                let candidate_key = v3_relay_provider_candidate_key(&selected.candidate);
                busy_selected_candidates.insert(candidate_key.clone(), (selected, capacity_key));
                busy_candidates.insert(candidate_key);
                if !reselect_busy_candidate {
                    return V3AdmittedTargetSelectionAfterRescue::Exhausted(
                        v3_provider_busy_target_exhaustion(&expanded, &busy_candidates),
                    );
                }
            }
            V3TargetSelectionAfterRescue::Failed(source) => {
                return V3AdmittedTargetSelectionAfterRescue::Failed(source);
            }
            V3TargetSelectionAfterRescue::Exhausted(exhausted) => {
                if busy_candidates.is_empty() {
                    return V3AdmittedTargetSelectionAfterRescue::Exhausted(exhausted);
                }
                for (_candidate_key, (selected, capacity_key)) in &busy_selected_candidates {
                    if let Some(admission) =
                        controller.try_acquire_scheduled_probe(capacity_key, now_ms)
                    {
                        return V3AdmittedTargetSelectionAfterRescue::Selected(
                            V3AdmittedTargetSelection {
                                selected: selected.clone(),
                                admission: V3RuntimeProviderAdmission::new(
                                    controller.clone(),
                                    admission,
                                ),
                            },
                        );
                    }
                }
                return V3AdmittedTargetSelectionAfterRescue::Exhausted(
                    v3_provider_busy_target_exhaustion(&expanded, &busy_candidates),
                );
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
    ) -> Result<(), String> {
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
                    return health
                        .store
                        .wait_for_provider_cooldown_probe_completion(
                            &provider_id,
                            Some(&auth_alias),
                            Some(&model_id),
                        )
                        .await
                        .map_err(|error| error.to_string());
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
                        .map_err(|error| error.to_string()),
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
                        Ok(())
                    }
                };
                drop(cancellation);
                completion
            });
        }
        for result in futures_util::future::join_all(probes).await {
            result?;
        }
        Ok(())
    }

    pub(crate) async fn run_exhaustion_rescue_probes(
        &self,
        manifest: &V3Config05ManifestPublished,
        expanded: &V3Target09CandidateSetExpanded,
        now_ms: u64,
    ) -> Result<(), String> {
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
        true,
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
    let initial_exhaustion = match initial_selection {
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
                    Ok(selected) => return V3TargetSelectionAfterRescue::Selected(selected),
                    Err(exhausted) => exhausted,
                }
            } else {
                return V3TargetSelectionAfterRescue::Selected(selected);
            }
        }
        Err(exhausted) => exhausted,
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
        if let Err(error) = provider_health
            .run_exhaustion_rescue_probes(manifest, &expanded, retry_now_ms)
            .await
        {
            return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                "V3ProviderCooldownRescueProbe",
                "target_exhaustion_rescue_probe_failed",
                error,
            ));
        }
        if provider_health.store.availability_generation() != observed_generation {
            continue;
        }
        let wait_result = match next_provider_cooldown_probe_deadline(
            &expanded,
            request_local_excluded_candidates,
            provider_health,
        ) {
            Ok(Some(deadline_ms)) => {
                let now_ms = match v3_relay_provider_policy_now_epoch_ms() {
                    Ok(now_ms) => now_ms,
                    Err(error) => {
                        return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                            "V3ProviderCooldownRescueProbe",
                            "target_exhaustion_rescue_clock_failed",
                            error,
                        ))
                    }
                };
                let sleep_ms = deadline_ms.saturating_sub(now_ms);
                if sleep_ms == 0 {
                    Ok(())
                } else {
                    tokio::select! {
                        result = provider_health.store.wait_for_availability_change(observed_generation) => {
                            result.map(|_| ()).map_err(|error| error.to_string())
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)) => Ok(()),
                    }
                }
            }
            Ok(None) => provider_health
                .store
                .wait_for_availability_change(observed_generation)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = wait_result {
            return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
                "V3ProviderCooldownRescueProbe",
                "target_exhaustion_rescue_wait_failed",
                error,
            ));
        }
    }
}

fn next_provider_cooldown_probe_deadline(
    expanded: &V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: &BTreeSet<String>,
    provider_health: &V3ProviderFailureRuntimeHealth,
) -> Result<Option<u64>, String> {
    let mut deadline_ms: Option<u64> = None;
    for candidate in expanded.candidates.iter().filter(|candidate| {
        !request_local_excluded_candidates.contains(&v3_relay_provider_candidate_key(candidate))
    }) {
        let next = provider_health
            .store
            .provider_cooldown_probe_next_deadline_ms(
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
            )
            .map_err(|error| error.to_string())?;
        deadline_ms = match (deadline_ms, next) {
            (Some(current), Some(next)) => Some(current.min(next)),
            (None, next) => next,
            (current, None) => current,
        };
    }
    Ok(deadline_ms)
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
            let projection = availability.availability(
                &candidate.provider_id,
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
