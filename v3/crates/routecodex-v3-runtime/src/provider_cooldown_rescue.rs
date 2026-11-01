pub(crate) enum V3SynchronousTargetPlanningStep {
    Selected(V3Target10ConcreteProviderSelected),
    Exhausted(V3TargetExhaustion),
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

pub(crate) enum V3SynchronousTargetSelectionStep {
    Selected {
        selected: V3Target10ConcreteProviderSelected,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    Exhausted {
        exhaustion: V3TargetExhaustion,
        source: Option<routecodex_v3_error::V3Error01SourceRaised>,
        request_local_excluded_candidates: BTreeSet<String>,
        request_local_busy_candidates: BTreeSet<String>,
    },
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

pub(crate) struct V3SynchronousTargetPlanningInput<'a> {
    pub(crate) expanded: V3Target09CandidateSetExpanded,
    pub(crate) failure_session_scope: &'a V3ProviderFailureSessionScope,
    pub(crate) provider_health: &'a V3ProviderFailureRuntimeHealth,
    pub(crate) request_local_excluded_candidates: &'a BTreeSet<String>,
    pub(crate) request_local_busy_candidates: &'a BTreeSet<String>,
    pub(crate) now_ms: u64,
    pub(crate) deterministic_sample: u64,
    pub(crate) preferred_selected: Option<V3Target10ConcreteProviderSelected>,
}

pub(crate) fn step_v3_target_planning_sync(
    input: V3SynchronousTargetPlanningInput<'_>,
) -> V3SynchronousTargetPlanningStep {
    let V3SynchronousTargetPlanningInput {
        expanded,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        request_local_busy_candidates: _,
        now_ms,
        deterministic_sample,
        preferred_selected,
    } = input;
    let target = V3TargetInterpreter::default();

    if let Some(preferred) = preferred_selected {
        let key = v3_relay_provider_candidate_key(&preferred.candidate);
        if !request_local_excluded_candidates.contains(&key)
            && V3TargetInterpreter::candidate_admitted_for_request(
                &preferred.candidate,
                now_ms,
                expanded.route.request_input_tokens,
            )
        {
            let projection = provider_health.session_bound_availability(failure_session_scope)
                .availability_for_interface(
                    &preferred.candidate.provider_id,
                    &preferred.candidate.interface_id,
                    Some(&preferred.candidate.auth_alias),
                    Some(&preferred.candidate.model_id),
                    now_ms,
                );
            match projection {
                Ok(projection) if projection.available => return V3SynchronousTargetPlanningStep::Selected(preferred),
                Ok(_) => {},
                Err(error) => return V3SynchronousTargetPlanningStep::Failed(
                    routecodex_v3_error::build_v3_error_01_source_raised(
                        routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure, "V3ProviderHealthRead",
                        "provider_health_read_failed", error.to_string(),
                    )),
            }
        }
    }

    let selected = match select_v3_target_with_session_then_global(
        &target,
        expanded,
        failure_session_scope,
        &provider_health.session_bound_availability(failure_session_scope),
        provider_health,
        request_local_excluded_candidates,
        now_ms,
        deterministic_sample,
    ) {
        Ok(selected) => selected,
        Err(routecodex_v3_target::V3TargetSelectionError::Exhausted(exhausted)) => return V3SynchronousTargetPlanningStep::Exhausted(exhausted),
        Err(error @ routecodex_v3_target::V3TargetSelectionError::Health { .. }) => return V3SynchronousTargetPlanningStep::Failed(
            routecodex_v3_error::build_v3_error_01_source_raised(
                routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure, "V3ProviderHealthRead",
                "provider_health_read_failed", error.to_string(),
            )),
    };
    V3SynchronousTargetPlanningStep::Selected(selected)
}

pub(crate) fn step_v3_target_selection_sync(
    input: V3SynchronousTargetPlanningInput<'_>,
) -> V3SynchronousTargetSelectionStep {
    let V3SynchronousTargetPlanningInput {
        expanded,
        failure_session_scope,
        provider_health,
        request_local_excluded_candidates,
        request_local_busy_candidates: _,
        now_ms,
        deterministic_sample,
        preferred_selected,
    } = input;
    let excluded = request_local_excluded_candidates.clone();
    let busy = BTreeSet::new();
    {
        let step = step_v3_target_planning_sync(V3SynchronousTargetPlanningInput {
            expanded: expanded.clone(),
            failure_session_scope,
            provider_health,
            request_local_excluded_candidates: &excluded,
            request_local_busy_candidates: &busy,
            now_ms,
            deterministic_sample,
            preferred_selected,
        });
        match step {
            V3SynchronousTargetPlanningStep::Selected(selected) => {
                return V3SynchronousTargetSelectionStep::Selected {
                    selected,
                    request_local_excluded_candidates: excluded,
                    request_local_busy_candidates: busy,
                };
            }
            V3SynchronousTargetPlanningStep::Exhausted(exhausted) => {
                return V3SynchronousTargetSelectionStep::Exhausted {
                    exhaustion: exhausted,
                    source: None,
                    request_local_excluded_candidates: excluded,
                    request_local_busy_candidates: busy,
                };
            }
            V3SynchronousTargetPlanningStep::Failed(source) => return V3SynchronousTargetSelectionStep::Failed(source),
        }
    }
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
}

pub(crate) fn v3_exhaustion_is_cooldown_only(
    expanded: &V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: &BTreeSet<String>,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    now_ms: u64,
) -> Result<bool, routecodex_v3_provider_responses::V3ProviderHealthError> {
    let availability = provider_health.session_bound_availability(failure_session_scope);
    let mut nonfailed_candidates = expanded.candidates.iter().filter(|candidate| {
        !request_local_excluded_candidates.contains(&v3_relay_provider_candidate_key(candidate))
    });
    let Some(first) = nonfailed_candidates.next() else {
        return Ok(false);
    };
    for candidate in std::iter::once(first).chain(nonfailed_candidates) {
            let projection = availability.availability_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                now_ms,
            )?;
            if !v3_availability_is_cooldown_recovery_only(&projection) { return Ok(false); }
    }
    Ok(true)
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
