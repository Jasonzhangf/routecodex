pub(crate) enum V3TargetSelectionAfterRescue {
    Selected(V3Target10ConcreteProviderSelected),
    Exhausted(V3TargetExhaustion),
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

impl V3ProviderFailureRuntimeHealth {
    async fn run_cooldown_rescue_probes_for_candidates(
        &self,
        manifest: &V3Config05ManifestPublished,
        candidates: &[V3TargetCandidate],
        now_ms: u64,
    ) -> Result<(), String> {
        let mut identities = BTreeSet::new();
        let mut permit_identities = BTreeSet::new();
        let mut probes: Vec<
            std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>,
        > = Vec::new();
        for candidate in candidates {
            let identity = (
                &candidate.provider_id,
                &candidate.auth_alias,
                &candidate.model_id,
            );
            if !identities.insert(identity) {
                continue;
            }
            let mut permits = self
                .store
                .acquire_provider_cooldown_rescue_probes(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                )
                .map_err(|error| error.to_string())?;
            let provider_id = candidate.provider_id.clone();
            let auth_alias = candidate.auth_alias.clone();
            let model_id = candidate.model_id.clone();
            permits.extend(
                self.store
                    .acquire_provider_cooldown_probes_if_due(
                        &provider_id,
                        Some(&auth_alias),
                        Some(&model_id),
                        now_ms,
                    )
                    .map_err(|error| error.to_string())?,
            );
            if permits.is_empty() {
                let health = self.clone();
                probes.push(Box::pin(async move {
                    health
                        .store
                        .wait_for_provider_cooldown_probe_completions(
                            &provider_id,
                            Some(&auth_alias),
                            Some(&model_id),
                        )
                        .await
                        .map_err(|error| error.to_string())
                }));
                continue;
            }
            for permit in permits {
                let permit_identity = (
                    permit.provider_id().to_string(),
                    permit.auth_alias().map(str::to_string),
                    permit.model_id().map(str::to_string),
                );
                if !permit_identities.insert(permit_identity) {
                    continue;
                }
                let health = self.clone();
                let target = build_v3_provider_global_probe_target(
                    manifest,
                    permit.provider_id(),
                    permit.auth_alias(),
                    permit.model_id(),
                )
                .map_err(|error| error.to_string());
                probes.push(Box::pin(async move {
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
                    Ok(target) => probe_v3_provider_global_target(target).await,
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
                }));
            }
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

pub(crate) async fn resolve_v3_relay_target_outcome_with_rescue(
    input: V3RelayProviderTargetResolutionInput<'_>,
) -> V3RelayProviderTargetResolution {
    let expanded = match build_v3_relay_target_candidates(&input) {
        Ok(expanded) => expanded,
        Err(resolution) => return resolution,
    };
    match select_v3_expanded_target_with_exhaustion_rescue(
        input.manifest,
        expanded,
        input.failure_session_scope,
        input.provider_health,
        input.request_local_excluded_candidates,
        input.now_ms,
        input.deterministic_sample,
        true,
    )
    .await
    {
        V3TargetSelectionAfterRescue::Selected(selected) => {
            V3RelayProviderTargetResolution::Selected(selected)
        }
        V3TargetSelectionAfterRescue::Exhausted(exhausted) => {
            V3RelayProviderTargetResolution::Exhausted {
                attempted_candidates: exhausted.attempted_candidates,
            }
        }
        V3TargetSelectionAfterRescue::Failed(source) => {
            V3RelayProviderTargetResolution::Failed(source)
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
                    .run_cooldown_rescue_probes_for_candidates(
                        manifest,
                        &rescue_candidates,
                        now_ms,
                    )
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
    std::iter::once(first).chain(nonfailed_candidates).all(|candidate| {
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
        && projection
            .blocked_scopes
            .iter()
            .all(|scope| {
                scope == "provider_cooldown_probe_pending"
                    || scope.starts_with(&format!("auth_key:{}:", projection.provider_id))
            })
        && projection
            .blocked_scopes
            .iter()
            .any(|scope| scope == "provider_cooldown_probe_pending")
}
