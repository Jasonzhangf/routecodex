fn v3_direct_retired_continuation_error(
    body: &Value,
) -> Option<crate::shared::V3DirectSourceError> {
    body.get("previous_response_id")
        .is_some_and(|value| !value.is_null())
        .then(|| {
            runtime_source(
                "V3HubReqInbound02Normalized",
                "Responses continuation is retired: previous_response_id is unsupported",
            )
        })
}

pub(crate) struct V3DirectProviderFailurePolicyResult {
    decision: V3Error05ExecutionDecision,
    retry_selected: Option<Box<routecodex_v3_target::V3Target10ConcreteProviderSelected>>,
    event: Option<V3RuntimeProviderFailureObservation>,
    /// health-neutral 瞬态失败（SSE 流内/挂起）：重试与切换不经过 provider
    /// action gate / recovery witness 等待，立即执行；由调用方据此跳过
    /// `pending_provider_action_recovery` 的 gate 等待。
    retryable_transient: bool,
}

pub(crate) struct V3DirectProviderFailurePolicyContext<
    'ctx,
    R: V3ProviderAvailabilityReader + ?Sized,
> {
    failure_session_scope: &'ctx V3ProviderFailureSessionScope,
    provider_health: &'ctx V3ProviderFailureRuntimeHealth,
    attempt_budget: Option<&'ctx crate::execution_control::V3AttemptBudget>,
    availability: &'ctx R,
    expanded: Option<&'ctx routecodex_v3_target::V3Target09CandidateSetExpanded>,
    provider_pinned: bool,
    now_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectPolicyFailure {
    pub(crate) original_source: V3Error01SourceRaised,
    pub(crate) policy_failure: V3Error01SourceRaised,
}

pub(crate) struct V3DirectProviderFailurePolicyState<'state> {
    failed_candidates: &'state mut BTreeSet<String>,
    same_candidate_retries: &'state mut BTreeMap<String, usize>,
    trace: &'state mut Vec<&'static str>,
}

fn direct_policy_failure(
    original_source: &V3Error01SourceRaised,
    source_stage: &'static str,
    error: impl std::fmt::Display,
) -> DirectPolicyFailure {
    DirectPolicyFailure {
        original_source: original_source.clone(),
        // A policy failure is the diagnostic leaf, not another Source01 run.
        policy_failure: build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            source_stage,
            "v3_route_target_runtime_failure",
            error.to_string(),
        ),
    }
}

fn run_v3_direct_policy_error_02_to_05_decision_from_projection(
    source_projection: serde_json::Value,
    original_source: &V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
) -> Result<V3Error05ExecutionDecision, DirectPolicyFailure> {
    crate::operation_runner::run_v3_error_02_to_05_decision_operators(
        source_projection,
        original_source.clone(),
        scope,
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
        recovery,
    )
    .map(|(_decision_projection, decision)| decision)
    .map_err(|error| direct_policy_failure(original_source, "V3Error05ExecutionDecision", error))
}

fn run_v3_direct_policy_error_02_to_05_decision(
    original_source: &V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
    target_recovery_pending: bool,
) -> Result<V3Error05ExecutionDecision, DirectPolicyFailure> {
    let source_projection = serde_json::to_value(original_source)
        .map_err(|error| direct_policy_failure(original_source, "V3Error02Classified", error))?;
    crate::operation_runner::run_v3_error_02_to_05_decision_operators_with_target_recovery(
        source_projection,
        original_source.clone(),
        scope,
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
        recovery,
        target_recovery_pending,
    )
    .map(|(_, decision)| decision)
    .map_err(|error| direct_policy_failure(original_source, "V3Error05ExecutionDecision", error))
}

fn record_v3_direct_provider_failure_record(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: &V3Error01SourceRaised,
    now_epoch_ms: u64,
) -> crate::shared::V3DirectSourceResult<V3ProviderFailureRecord> {
    provider_health
        .record_provider_failure_record_from_source_for_interface(
            failure_session_scope,
            &selected.candidate.provider_id,
            &selected.candidate.interface_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            source,
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

fn record_v3_direct_provider_success(
    receipt: &V3AttemptSuccessReceipt,
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    now_epoch_ms: u64,
) -> crate::shared::V3DirectSourceResult<()> {
    provider_health
        .record_provider_success_in_failure_scope_for_interface(
            receipt,
            failure_session_scope,
            &selected.candidate.provider_id,
            &selected.candidate.interface_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

#[cfg(test)]
mod external_http_witness_tests {
    use super::*;
    use crate::hub_v1::external_http_witness_from_provider_error;

    #[test]
    fn direct_retains_exact_real_http_error_including_upstream_502() {
        let response = routecodex_v3_provider_responses::V3ProviderHttpFailure {
            request_id: "request".into(),
            provider_id: "provider".into(),
            status: 429,
            headers: vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/html; charset=utf-8".to_vec(),
            }],
            body: b"<html>limit</html>".to_vec(),
            body_read_failure: None,
        };
        let error = V3ProviderError::HttpStatus {
            response: Box::new(response.clone()),
        };
        let witness = external_http_witness_from_provider_error(&error).unwrap();
        assert_eq!(witness.status(), 429);
        assert_eq!(witness.headers()[0].1, b"text/html; charset=utf-8");
        assert_eq!(witness.body(), response.body);
        // An upstream 502 is real evidence even though it never reaches a client.
        let upstream_502 = V3ProviderError::HttpStatus {
            response: Box::new(routecodex_v3_provider_responses::V3ProviderHttpFailure {
                status: 502,
                body: b"bad gateway".to_vec(),
                ..response
            }),
        };
        let witness = external_http_witness_from_provider_error(&upstream_502).unwrap();
        assert_eq!(witness.status(), 502);
        assert_eq!(witness.body(), b"bad gateway");
    }

    #[test]
    fn direct_policy_sdk_failure_preserves_source_and_terminal_witness() {
        let original_source = build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_http_200",
            "provider returned HTTP 200",
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(200),
                code: Some("HTTP_200".to_string()),
                provider_id: Some("provider-a".to_string()),
                upstream_request_id: None,
                message: Some("provider returned HTTP 200".to_string()),
            },
        );
        let failure = run_v3_direct_policy_error_02_to_05_decision_from_projection(
            json!(null),
            &original_source,
            V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            1,
            false,
            false,
            None,
        )
        .expect_err("the SDK must reject a non-object Error02 projection");

        assert_eq!(failure.original_source, original_source);
        assert_eq!(
            failure.policy_failure.source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(
            failure.policy_failure.source_stage,
            "V3Error05ExecutionDecision"
        );
        assert_eq!(
            failure.policy_failure.code,
            "v3_route_target_runtime_failure"
        );
        assert!(failure.policy_failure.internal_error.is_none());
        assert!(failure.policy_failure.external_error.is_none());

        let witness = V3ExternalHttpWitness::new(
            200,
            vec![("content-type".into(), b"application/json".to_vec())],
            br#"{"id":"provider-response"}"#.to_vec(),
        );
        let policy_failure = failure.policy_failure.clone();
        let output = policy_failure_output_with_observability(
            failure.clone(),
            Some(witness.clone()),
            Vec::new(),
            None,
        );
        assert_eq!(
            output.diagnostic_source.as_ref(),
            Some(&failure.policy_failure)
        );
        assert_eq!(output.diagnostic_cause.as_ref(), Some(&original_source));
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
        assert_eq!(output.error_chain, None);

        let no_response = policy_failure_output_with_observability(failure, None, Vec::new(), None);
        assert_eq!(
            no_response.terminal_disposition,
            Some(V3ProviderTerminalDisposition::NoResponse)
        );
        assert_eq!(
            no_response.diagnostic_source.as_ref(),
            Some(&policy_failure)
        );
        assert_eq!(
            no_response.diagnostic_cause.as_ref(),
            Some(&original_source)
        );
        assert_eq!(no_response.error_chain, None);
    }
}

fn is_direct_first_byte_timeout_code(code: &str) -> bool {
    code == V3_TRANSIENT_TRANSPORT_HANG_CODE || code == "provider_response_sse_first_event_timeout"
}

pub(crate) async fn run_v3_direct_provider_failure_policy<R: V3ProviderAvailabilityReader>(
    context: &V3DirectProviderFailurePolicyContext<'_, R>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    state: &mut V3DirectProviderFailurePolicyState<'_>,
) -> Result<V3DirectProviderFailurePolicyResult, DirectPolicyFailure> {
    let hold_error_return = source.external_error.is_some()
        && !matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect);
    let result = run_v3_direct_provider_failure_policy_inner(context, selected, source, status, state).await;
    if hold_error_return
        && result.as_ref().is_ok_and(|outcome| {
            matches!(outcome.decision.action, V3Error05ExecutionAction::ProjectTerminal)
        })
    {
        crate::provider_failure_runtime_policy::hold_provider_error_return().await;
    }
    result
}

async fn run_v3_direct_provider_failure_policy_inner<R: V3ProviderAvailabilityReader>(
    context: &V3DirectProviderFailurePolicyContext<'_, R>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    state: &mut V3DirectProviderFailurePolicyState<'_>,
) -> Result<V3DirectProviderFailurePolicyResult, DirectPolicyFailure> {
    if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect) {
        let decision = run_v3_direct_policy_error_02_to_05_decision(
            &source,
            V3ErrorActionScope::ProviderInstance {
                provider_id: selected.candidate.provider_id.clone(),
            },
            0,
            false,
            false,
            None,
            false,
        )?;
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event: None,
            retryable_transient: false,
        });
    }
    let observed_status = source
        .external_error
        .as_ref()
        .and_then(|error| error.status)
        .filter(|external_status| *external_status >= 400)
        .unwrap_or(status);
    let rate_limited = observed_status == 429;
    let is_response_processing_failure =
        routecodex_v3_error::is_v3_recoverable_response_processing_source(&source);
    let is_health_neutral_failure = is_response_processing_failure
        || crate::provider_failure_runtime_policy::is_health_neutral_request_compat_failure(
            source.source_stage,
            source
                .external_error
                .as_ref()
                .and_then(|error| error.code.as_deref()),
        );
    let failed_key = candidate_key(&selected.candidate);
    if let Some(budget) = context.attempt_budget {
        let recovery_revision = context.provider_health.store()
            .recovery_success_revision_for_interface(
                &selected.candidate.provider_id,
                &selected.candidate.interface_id,
                &selected.candidate.auth_alias,
                &selected.candidate.model_id,
            )
            .map_err(|error| direct_policy_failure(&source, "V3ProviderHealthRead", error))?;
        budget
            .record_request_candidate_attempt(failed_key.clone(), recovery_revision)
            .map_err(|error| direct_policy_failure(&source, "V3RequestExecutionControl", error))?;
    }
    let expanded_candidates = match (context.expanded, context.provider_pinned) {
        (Some(expanded), _) => Some(&expanded.candidates),
        (None, true) => None,
        (None, false) => {
            return Err(direct_policy_failure(
                &source,
                "V3Target09CandidateSetExpanded",
                "routed candidate set missing",
            ))
        }
    };
    let provider_first_byte_hang = is_direct_first_byte_timeout_code(&source.code);
    let request_local_excluded = BTreeSet::from([failed_key.clone()]);
    let mut failed_with_current = state.failed_candidates.clone();
    if let Some(budget) = context.attempt_budget {
        failed_with_current.extend(
            budget.request_candidate_attempts().map_err(|error| {
                direct_policy_failure(&source, "V3RequestExecutionControl", error)
            })?,
        );
    }
    failed_with_current.extend(request_local_excluded.iter().cloned());
    let request_input_tokens = context
        .expanded
        .map_or(0, |expanded| expanded.route.request_input_tokens);
    let mut remaining = if let Some(expanded_candidates) = expanded_candidates {
        remaining_available_candidates(
            expanded_candidates,
            context.availability,
            &failed_with_current,
            context.now_epoch_ms,
            request_input_tokens,
        ).map_err(|error| direct_policy_failure(&source, "V3ProviderHealthRead", error))?
    } else { 0 };
    let mut next_provider_key = if let Some(expanded_candidates) = expanded_candidates {
        first_remaining_available_candidate_key(
            expanded_candidates,
            context.availability,
            &failed_with_current,
            context.now_epoch_ms,
            request_input_tokens,
        ).map_err(|error| direct_policy_failure(&source, "V3ProviderHealthRead", error))?
    } else { None };
    if remaining == 0 {
        if let Some(candidates) = expanded_candidates {
            if candidates.len() > 1 {
                for candidate in candidates {
                    let key = candidate_key(candidate);
                    if failed_with_current.contains(&key)
                        || !routecodex_v3_target::V3TargetInterpreter::candidate_admitted_for_request(candidate, context.now_epoch_ms, request_input_tokens)
                    {
                        continue;
                    }
                    let available = context.provider_health.availability_for_interface(
                        &candidate.provider_id, &candidate.interface_id, Some(&candidate.auth_alias),
                        Some(&candidate.model_id), context.now_epoch_ms,
                    ).map_err(|error| direct_policy_failure(&source, "V3ProviderHealthRead", error))?;
                    if available.available {
                        remaining += 1;
                        if next_provider_key.is_none() { next_provider_key = Some(key); }
                    }
                }
            }
        }
    }
    // Resolve the exact healthy alternative before the failed identity's
    // health mutation. Error05 re-evaluates the normal planner with this
    // preferred candidate; it must not discard the already-proved sibling and
    // reselect the just-failed higher-priority identity.
    let reselected_alternative = if let Some(expanded) = context.expanded {
        match crate::provider_failure_runtime_policy::select_v3_target_with_session_then_global(
            &routecodex_v3_target::V3TargetInterpreter::default(),
            expanded.clone(),
            context.failure_session_scope,
            context.availability,
            context.provider_health,
            &failed_with_current,
            context.now_epoch_ms,
            0,
        ) {
            Ok(selected) => Some(selected),
            Err(routecodex_v3_target::V3TargetSelectionError::Exhausted(_)) => None,
            Err(error @ routecodex_v3_target::V3TargetSelectionError::Health { .. }) => {
                return Err(direct_policy_failure(&source, "V3ProviderHealthRead", error));
            }
        }
    } else { None };
    if reselected_alternative.is_some() {
        remaining = 1;
        next_provider_key = reselected_alternative
            .as_ref()
            .map(|alternative| candidate_key(&alternative.candidate));
    } else if rate_limited {
        remaining = 0;
        next_provider_key = None;
    }
    if provider_first_byte_hang {
        state
            .failed_candidates
            .extend(request_local_excluded.iter().cloned());
    } else if is_health_neutral_failure {
        state.failed_candidates.insert(failed_key.clone());
    }
    // Each real failure contributes to identity health even if no alternate
    // candidate is currently available. Request recovery remains independent.
    let health_record = if is_health_neutral_failure || (remaining == 0 && !rate_limited) {
        context
            .provider_health
            .record_real_provider_error_for_interface(
                &selected.candidate.provider_id,
                &selected.candidate.interface_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                &source,
                context.now_epoch_ms,
            )
            .map_err(|error| {
                direct_policy_failure(&source, "V3ProviderHealthStateMutated", error)
            })?;
        V3ProviderFailureRecord {
            scope_label: failed_key.clone(),
            provider_key: failed_key.clone(),
            state: if rate_limited {
                "rate_limit_capacity_wait"
            } else if is_response_processing_failure {
                "request_local_response_processing"
            } else if is_health_neutral_failure {
                "request_local_provider_compat"
            } else {
                "last_candidate_terminal"
            }
            .to_string(),
            failure_count: 0,
            cooldown_until_ms: None,
            recovery_success_revision: None,
            reason: (!source.message.trim().is_empty()).then(|| source.message.clone()),
        }
    } else {
        match record_v3_direct_provider_failure_record(
            context.provider_health,
            context.failure_session_scope,
            selected,
            &source,
            context.now_epoch_ms,
        ) {
            Ok(record) => record,
            Err(Ok(policy_failure)) => {
                return Err(DirectPolicyFailure {
                    original_source: source.clone(),
                    policy_failure,
                })
            }
            Err(Err(fault)) => {
                return Err(DirectPolicyFailure {
                    original_source: fault.original_source.unwrap_or_else(|| source.clone()),
                    policy_failure: fault.policy_failure,
                })
            }
        }
    };
    let provider_key_model_scope = V3ErrorActionScope::ProviderKeyModel {
        provider_id: selected.candidate.provider_id.clone(),
        auth_alias: selected.candidate.auth_alias.clone(),
        model_id: selected.candidate.model_id.clone(),
    };
    let recovery_witness = match (
        rate_limited && !is_health_neutral_failure,
        remaining > 0 && is_health_neutral_failure,
    ) {
        (true, _) => Some(
            routecodex_v3_error::V3Error05RecoveryAdmissionWitness::new(
                context.failure_session_scope.clone(),
                failed_key.clone(),
                "provider_http_429",
                1,
            )
            .map_err(|error| {
                direct_policy_failure(&source, "V3ProviderActionGateAdmission", error)
            })?,
        ),
        (false, true) => Some(
            routecodex_v3_error::V3Error05RecoveryAdmissionWitness::new(
                context.failure_session_scope.clone(),
                failed_key.clone(),
                source.code.clone(),
                1,
            )
            .map_err(|error| {
                direct_policy_failure(&source, "V3ProviderActionGateAdmission", error)
            })?,
        ),
        _ => None,
    };
    let target_recovery_pending = match context.expanded {
        Some(_) if !is_health_neutral_failure => true,
        Some(expanded) if remaining == 0 => {
            // Permanent exclusions for this request are the request-local
            // compat exclusions and the just-failed identity. Prior health
            // attempts stay recoverable through a due probe or a matching
            // success revision, so they are not passed as permanent.
            let mut permanent_exclusions = state.failed_candidates.clone();
            permanent_exclusions.extend(request_local_excluded.iter().cloned());
            crate::provider_failure_runtime_policy::v3_exhaustion_is_cooldown_only(
                expanded, &permanent_exclusions, context.failure_session_scope,
                context.provider_health, context.now_epoch_ms,
            ).map_err(|error| direct_policy_failure(&source, "V3ProviderHealthRead", error))?
        }
        _ => false,
    };
    let decision = run_v3_direct_policy_error_02_to_05_decision(
        &source,
        provider_key_model_scope,
        remaining,
        false,
        false,
        recovery_witness,
        target_recovery_pending,
    )?;
    state
        .trace
        .extend(V3_ERROR_CHAIN_NODE_IDS.iter().take(5).copied());
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
            | V3Error05ExecutionAction::ReevaluateTarget
    ) {
        state.trace.push("V3TargetLocalReselected");
        let event = Some(build_v3_direct_provider_failure_observation(
            selected,
            observed_status,
            &source,
            &health_record,
            "switch_provider",
            next_provider_key,
            None,
        ));
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: reselected_alternative.map(Box::new),
            event,
            // Candidate-scoped request/provider compatibility failures are
            // health-neutral and must reselect immediately without entering
            // the provider action gate.
            retryable_transient: is_health_neutral_failure || rate_limited,
        });
    }
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenRetrySame { .. }
    ) {
        if rate_limited {
            let event = Some(build_v3_direct_provider_failure_observation(
                selected,
                observed_status,
                &source,
                &health_record,
                "wait_rate_limit_capacity",
                Some(failed_key),
                Some(1_000),
            ));
            return Ok(V3DirectProviderFailurePolicyResult {
                decision,
                retry_selected: Some(Box::new(selected.clone())),
                event,
                retryable_transient: false,
            });
        }
        return Err(direct_policy_failure(
            &source,
            "V3Error05ExecutionDecision",
            "retry_same is not a production provider failure action",
        ));
    }
    if !matches!(decision.action, V3Error05ExecutionAction::ProjectTerminal) {
        return Err(direct_policy_failure(
            &source,
            "V3Error05ExecutionDecision",
            format!(
                "provider failure produced invalid Error05 action {:?}",
                decision.action
            ),
        ));
    }
    state.trace.push("V3Error06ClientProjected");
    let event = Some(build_v3_direct_provider_failure_observation(
        selected,
        observed_status,
        &source,
        &health_record,
        "terminal_default_floor_exhausted",
        None,
        None,
    ));
    Ok(V3DirectProviderFailurePolicyResult {
        decision,
        retry_selected: None,
        event,
        retryable_transient: false,
    })
}

fn build_v3_direct_provider_failure_observation(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    status: u16,
    source: &V3Error01SourceRaised,
    health_record: &V3ProviderFailureRecord,
    action: &str,
    next_provider_key: Option<String>,
    wait_ms: Option<u64>,
) -> V3RuntimeProviderFailureObservation {
    let response_processing_failure =
        routecodex_v3_error::is_v3_recoverable_response_processing_source(source);
    let observed_status = if response_processing_failure {
        match source.internal_error.as_ref().map(|error| error.lane) {
            Some(routecodex_v3_error::V3InternalErrorLane::Request) => 598,
            _ => 599,
        }
    } else {
        source
            .external_error
            .as_ref()
            .and_then(|external| external.status)
            .filter(|external_status| *external_status >= 400)
            .unwrap_or(status)
    };
    V3RuntimeProviderFailureObservation {
        provider_key: candidate_key(&selected.candidate),
        provider_id: selected.candidate.provider_id.clone(),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        model_id: selected.candidate.model_id.clone(),
        status: observed_status,
        error_type: Some(source.code.clone()),
        external_error_kind: source
            .external_error
            .as_ref()
            .map(|external| external_kind_label(&external.kind).to_string()),
        external_error_code: source
            .external_error
            .as_ref()
            .and_then(|external| external.code.clone()),
        external_error_status: source
            .external_error
            .as_ref()
            .and_then(|external| external.status)
            .or_else(|| {
                (response_processing_failure && (200..300).contains(&status)).then_some(status)
            }),
        internal_code: source
            .internal_error
            .as_ref()
            .map(|internal| internal.internal_code.to_string()),
        upstream_request_id: source
            .external_error
            .as_ref()
            .and_then(|external| external.upstream_request_id.clone()),
        message: source.message.clone(),
        failure_count: health_record.failure_count,
        health_state: health_record.state.clone(),
        cooldown_until_ms: health_record.cooldown_until_ms,
        action: action.to_string(),
        next_provider_key,
        wait_ms,
        diagnostic_source: Some(source.clone()),
        failed_attempt_evidence: None,
    }
}

pub(crate) fn publish_v3_direct_provider_failure_event(
    sink: Option<&V3RuntimeProviderFailureEventSink>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    entry_protocol: &str,
    transport: &str,
    status: Option<u16>,
    provider_failure_events: &[V3RuntimeProviderFailureObservation],
    event: &V3RuntimeProviderFailureObservation,
    attempts: usize,
) {
    if let Some(sink) = sink {
        let mut observability = build_v3_direct_runtime_observability(
            selected,
            entry_protocol,
            transport,
            status,
            "failed",
            provider_failure_events.to_vec(),
        );
        observability.attempts = Some(attempts);
        sink(&observability, event);
    }
}

fn external_kind_label(kind: &V3ExternalErrorKind) -> &'static str {
    match kind {
        V3ExternalErrorKind::Provider => "provider",
        V3ExternalErrorKind::Upstream => "upstream",
        V3ExternalErrorKind::Client => "client",
        V3ExternalErrorKind::Transport => "transport",
    }
}

pub(crate) fn build_v3_direct_runtime_observability(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    entry_protocol: &str,
    transport: &str,
    provider_status: Option<u16>,
    response_status: &str,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: entry_protocol.to_string(),
        execution_mode: "direct".to_string(),
        transport: transport.to_string(),
        routing_group_id: Some(selected.route.routing_group_id.clone()),
        route_classification_reason: Some(selected.route.route_classification_reason.clone()),
        pool_id: Some(selected.route.pool_id.clone()),
        provider_id: Some(selected.candidate.provider_id.clone()),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        provider_key: Some(candidate_key(&selected.candidate)),
        provider_type: Some(selected.candidate.provider_type.clone()),
        model_id: Some(selected.candidate.model_id.clone()),
        wire_model: Some(selected.candidate.wire_model.clone()),
        provider_status,
        response_status: Some(response_status.to_string()),
        finish_reason: None,
        attempts: Some(selected.attempts),
        unavailable_candidates: selected.unavailable_candidates.clone(),
        provider_failure_events,
        target_path: selected.candidate.path.clone(),
        usage: None,
        timing: None,
    }
}

fn v3_direct_client_transport_label(payload: &V3Resp15ClientPayload) -> &str {
    match &payload.body {
        V3ClientBody::Json(_) => "json",
        V3ClientBody::Bytes(_) => "bytes",
        V3ClientBody::Sse(_) => "sse",
        V3ClientBody::CommittedSse(_) => "sse",
    }
}

include!("direct_runtime_helpers_stream.rs");
include!("direct_response_thinking_compat.rs");
