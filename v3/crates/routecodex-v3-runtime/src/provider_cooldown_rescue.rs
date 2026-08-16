pub(crate) enum V3TargetSelectionAfterRescue {
    Selected(V3Target10ConcreteProviderSelected),
    Exhausted(V3TargetExhaustion),
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) async fn run_exhaustion_rescue_probes(
        &self,
        manifest: &V3Config05ManifestPublished,
        expanded: &V3Target09CandidateSetExpanded,
    ) -> Result<(), String> {
        let mut identities = BTreeSet::new();
        let mut probes = Vec::new();
        for candidate in &expanded.candidates {
            let identity = format!("{}:{}", candidate.provider_id, candidate.auth_alias);
            if !identities.insert(identity) {
                continue;
            }
            let acquired = self
                .store
                .try_acquire_provider_cooldown_rescue_probe(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                )
                .map_err(|error| error.to_string())?;
            let health = self.clone();
            let provider_id = candidate.provider_id.clone();
            let auth_alias = candidate.auth_alias.clone();
            let model_id = candidate.model_id.clone();
            let target = acquired
                .then(|| {
                    build_v3_provider_global_probe_target(
                        manifest,
                        &provider_id,
                        Some(&auth_alias),
                        Some(&model_id),
                    )
                })
                .transpose();
            probes.push(async move {
                if !acquired {
                    return health
                        .store
                        .wait_for_provider_cooldown_probe_completion(
                            &provider_id,
                            Some(&auth_alias),
                            Some(&model_id),
                        )
                        .await
                        .map_err(|error| error.to_string());
                }
                let result = match target {
                    Ok(Some(target)) => probe_v3_provider_global_target(target).await,
                    Ok(None) => Err(format!(
                        "provider cooldown rescue probe target missing for {provider_id}:{auth_alias}"
                    )),
                    Err(error) => Err(error),
                };
                match result {
                    Ok(()) => health
                        .store
                        .complete_provider_cooldown_probe_success(
                            &provider_id,
                            Some(&auth_alias),
                            Some(&model_id),
                        )
                        .map_err(|error| error.to_string()),
                    Err(_error) => {
                        health
                            .store
                            .complete_provider_cooldown_probe_failure(
                                &provider_id,
                                Some(&auth_alias),
                                Some(&model_id),
                                v3_relay_provider_policy_now_epoch_ms()?,
                            )
                            .map_err(|store_error| store_error.to_string())?;
                        Ok(())
                    }
                }
            });
        }
        for result in futures_util::future::join_all(probes).await {
            result?;
        }
        Ok(())
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
    allow_exhaustion_rescue_probe: bool,
) -> V3TargetSelectionAfterRescue {
    let target = V3TargetInterpreter::default();
    let session_availability = provider_health.session_bound_availability(failure_session_scope);
    let initial_exhaustion = match select_v3_target_with_session_then_global(
        &target,
        expanded.clone(),
        &session_availability,
        provider_health,
        request_local_excluded_candidates,
        now_ms,
    ) {
        Ok(selected) => return V3TargetSelectionAfterRescue::Selected(selected),
        Err(exhausted) => exhausted,
    };
    if !allow_exhaustion_rescue_probe {
        return V3TargetSelectionAfterRescue::Exhausted(initial_exhaustion);
    }
    if let Err(error) = provider_health
        .run_exhaustion_rescue_probes(manifest, &expanded)
        .await
    {
        return V3TargetSelectionAfterRescue::Failed(target_resolution_source(
            "V3ProviderCooldownRescueProbe",
            "target_exhaustion_rescue_probe_failed",
            error,
        ));
    }
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
    let retry_availability = provider_health.session_bound_availability(failure_session_scope);
    match select_v3_target_with_session_then_global(
        &target,
        expanded,
        &retry_availability,
        provider_health,
        request_local_excluded_candidates,
        retry_now_ms,
    ) {
        Ok(selected) => V3TargetSelectionAfterRescue::Selected(selected),
        Err(exhausted) => V3TargetSelectionAfterRescue::Exhausted(exhausted),
    }
}
