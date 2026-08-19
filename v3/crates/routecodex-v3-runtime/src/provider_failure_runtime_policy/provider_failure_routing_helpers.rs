use super::*;

pub(super) fn terminal_projection_for(
    decision: &V3Error05ExecutionDecision,
    matched_policy: Option<&V3ProviderErrorActionPolicyManifest>,
) -> Option<V3Error06ClientProjected> {
    let mut projected = decision
        .clone()
        .try_into_terminal()
        .ok()
        .map(V3ErrorHandlingCenter::project_terminal_decision)?;
    if let Some(V3ProviderDispositionStepManifest::Project {
        status,
        public_code,
        ..
    }) = matched_policy.and_then(|policy| {
        policy.path.iter().rev().find_map(|step| match step {
            V3ProviderDispositionStepManifest::Project { .. } => Some(step),
            _ => None,
        })
    }) {
        projected.status = *status;
        if let Some(public_code) = public_code {
            if let Some(error) = projected
                .body
                .as_object_mut()
                .and_then(|body| body.get_mut("error"))
                .and_then(Value::as_object_mut)
            {
                error.insert("code".to_string(), Value::String(public_code.clone()));
            }
        }
    }
    Some(projected)
}

pub(super) fn find_matching_provider_error_policy<'manifest>(
    manifest: &'manifest V3Config05ManifestPublished,
    provider_id: &str,
    provider_type: Option<&str>,
    model_id: Option<&str>,
    status: u16,
    error_type: Option<&str>,
    message: &str,
) -> Option<&'manifest V3ProviderErrorActionPolicyManifest> {
    manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| {
            provider_error_policy_matches_source_failure(
                policy,
                provider_id,
                provider_type,
                model_id,
                status,
                error_type,
            ) && (policy.matcher.content_contains_any.is_empty()
                || policy
                    .matcher
                    .content_contains_any
                    .iter()
                    .any(|value| message.contains(value))
                || error_type == Some(policy.action.reason_code.as_str()))
        })
}

pub(super) fn build_v3_relay_provider_error_05_decision(
    selected: &V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    status: u16,
    error_type: Option<&str>,
    message: &str,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> V3Error05ExecutionDecision {
    let code = error_type.unwrap_or("provider_failure").to_string();
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        source_stage,
        code.clone(),
        message,
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(status),
            code: Some(code),
            provider_id: Some(selected.candidate.provider_id.clone()),
            upstream_request_id: None,
            message: Some(message.to_string()),
        },
    );
    V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source,
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: selected.candidate.provider_id.clone(),
                model_id: selected.candidate.model_id.clone(),
            },
            candidates_remaining: route_pool_remaining_after_exclusion,
            source_status: Some(status),
        },
        default_pool_available,
        same_provider_retry_available,
        recovery,
    )
}

pub(crate) fn expand_v3_relay_target_plan_for_selected(
    manifest: &V3Config05ManifestPublished,
    selected: &V3Target10ConcreteProviderSelected,
    deterministic_sample: u64,
) -> Result<V3Target09CandidateSetExpanded, String> {
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(selected.route.clone());
    target
        .expand_candidates(manifest, kind, deterministic_sample)
        .map_err(|error| error.to_string())
}

pub(super) fn build_v3_relay_target_candidates(
    input: &V3RelayProviderTargetResolutionInput<'_>,
) -> Result<V3Target09CandidateSetExpanded, V3RelayProviderTargetResolution> {
    let facts = crate::build_v3_router_request_facts_for_entry_with_manifest(
        input.body,
        input.entry_kind,
        crate::configured_v3_longcontext_threshold_tokens(input.manifest, input.server_id),
        input.manifest,
    );
    let router = V3VirtualRouter::process_shared();
    let classified = match router.classify_request_with_facts(
        input.manifest,
        input.server_id,
        input.endpoint_path,
        facts,
    ) {
        Ok(classified) => classified,
        Err(error) => {
            return Err(V3RelayProviderTargetResolution::Failed(
                target_resolution_source(
                    "V3Router05RequestClassified",
                    "target_resolution_classification_failed",
                    error,
                ),
            ))
        }
    };
    let plan = match router.resolve_route_pool_plan(input.manifest, classified) {
        Ok(plan) => plan,
        Err(error) => {
            return Err(V3RelayProviderTargetResolution::Failed(
                crate::shared::v3_route_plan_error_source(
                    "V3Router06RoutePoolResolved",
                    "target_resolution_route_plan_failed",
                    error,
                ),
            ))
        }
    };
    let hit = match router.hit_opaque_target_plan_once(plan, input.deterministic_sample) {
        Ok(hit) => hit,
        Err(error) => {
            return Err(V3RelayProviderTargetResolution::Failed(
                target_resolution_source(
                    "V3Router07OpaqueTargetHitOnce",
                    "target_resolution_opaque_target_failed",
                    error,
                ),
            ))
        }
    };
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    target
        .expand_candidates(input.manifest, kind, input.deterministic_sample)
        .map_err(|error| {
            V3RelayProviderTargetResolution::Failed(target_resolution_source(
                "V3Target09CandidateSetExpanded",
                "target_resolution_candidate_expansion_failed",
                error,
            ))
        })
}

pub(crate) fn resolve_v3_relay_target_outcome(
    input: V3RelayProviderTargetResolutionInput<'_>,
) -> V3RelayProviderTargetResolution {
    let expanded = match build_v3_relay_target_candidates(&input) {
        Ok(expanded) => expanded,
        Err(resolution) => return resolution,
    };
    let target = V3TargetInterpreter::default();
    let session_availability = input
        .provider_health
        .session_bound_availability(input.failure_session_scope);
    match select_v3_target_with_session_then_global(
        &target,
        expanded.clone(),
        &session_availability,
        input.request_local_excluded_candidates,
        input.now_ms,
    ) {
        Ok(selected) => V3RelayProviderTargetResolution::Selected(selected),
        Err(exhausted) => V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates: exhausted.attempted_candidates,
        },
    }
}

pub(super) fn target_resolution_source(
    stage: &'static str,
    code: &'static str,
    error: impl std::fmt::Display,
) -> routecodex_v3_error::V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        stage,
        code,
        error.to_string(),
    )
}

pub(crate) fn v3_relay_provider_target_selection_sample(request_id: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in request_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub(crate) fn v3_relay_provider_candidate_key(candidate: &V3TargetCandidate) -> String {
    v3_relay_provider_candidate_key_parts(
        &candidate.provider_id,
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

pub(crate) fn v3_relay_provider_candidate_key_parts(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or("-"),
        model_id.unwrap_or("-")
    )
}

pub(super) struct V3RelayProviderFailurePolicyEventInput {
    pub(super) candidate: V3TargetCandidate,
    pub(super) status: u16,
    pub(super) error_type: Option<String>,
    pub(super) message: String,
    pub(super) health_record: V3ProviderFailureRecord,
    pub(super) action: &'static str,
    pub(super) next_provider_key: Option<String>,
    pub(super) wait_ms: Option<u64>,
}

pub(super) fn build_v3_relay_provider_failure_policy_event(
    input: V3RelayProviderFailurePolicyEventInput,
) -> V3RelayProviderFailurePolicyEvent {
    V3RelayProviderFailurePolicyEvent {
        candidate: input.candidate,
        status: input.status,
        error_type: input.error_type,
        message: input.message,
        health_record: input.health_record,
        action: input.action.to_string(),
        next_provider_key: input.next_provider_key,
        wait_ms: input.wait_ms,
    }
}

pub(crate) fn v3_relay_provider_policy_now_epoch_ms() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("system time precedes Unix epoch: {error}"))
}
