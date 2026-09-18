fn v3_direct_selected_available_for_send(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    expanded: Option<&routecodex_v3_target::V3Target09CandidateSetExpanded>,
    session_availability: &impl V3ProviderAvailabilityReader,
    provider_health: &V3ProviderFailureRuntimeHealth,
    failed_candidates: &BTreeSet<String>,
    now_epoch_ms: u64,
) -> bool {
    let selected_key = candidate_key(&selected.candidate);
    let selected_available_in_session = session_availability
        .availability(
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            now_epoch_ms,
        )
        .available;
    let session_alternative_available = expanded.is_some_and(|expanded| {
        expanded.candidates.iter().any(|candidate| {
            let key = candidate_key(candidate);
            key != selected_key
                && !failed_candidates.contains(&key)
                && session_availability
                    .availability(
                        &candidate.provider_id,
                        Some(&candidate.auth_alias),
                        Some(&candidate.model_id),
                        now_epoch_ms,
                    )
                    .available
        })
    });
    selected_available_in_session
        || (expanded.is_some_and(|expanded| expanded.candidates.len() > 1)
            && !session_alternative_available
            && !failed_candidates.contains(&selected_key)
            && provider_health
                .availability(
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    now_epoch_ms,
                )
                .available)
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
    run_error: ErrorDecisionFn,
    availability: &'ctx R,
    expanded: Option<&'ctx routecodex_v3_target::V3Target09CandidateSetExpanded>,
    provider_pinned: bool,
    now_epoch_ms: u64,
}

pub(crate) type ErrorDecisionFn = fn(
    V3Error01SourceRaised,
    V3ErrorActionScope,
    usize,
    bool,
    bool,
    Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
) -> V3Error05ExecutionDecision;

pub(crate) struct V3DirectProviderFailurePolicyState<'state> {
    failed_candidates: &'state mut BTreeSet<String>,
    same_candidate_retries: &'state mut BTreeMap<String, usize>,
    trace: &'state mut Vec<&'static str>,
}

fn record_v3_direct_provider_failure_record(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: &V3Error01SourceRaised,
    now_epoch_ms: u64,
) -> Result<V3ProviderFailureRecord, V3Error01SourceRaised> {
    let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(
        source.clone(),
    );
    // 统一错误模型：direct runtime 路径同样经 internal 全局策略表盖章，
    // 400/无状态码失败与 401/403 按既定阈值进入冷却，不允许绕过。
    let status = source
        .external_error
        .as_ref()
        .and_then(|error| error.status)
        .unwrap_or(0);
    let action = crate::provider_failure_runtime_policy::apply_v3_internal_provider_failure_policy(
        routecodex_v3_error::build_v3_provider_failure_action_from_v3_error_02(&classified),
        source.source_stage,
        status,
        &source.code,
    );
    provider_health
        .record_provider_failure_record_with_action(
            failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            Some(&source.message),
            now_epoch_ms,
            &action,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

fn record_v3_direct_provider_success(
    receipt: &V3AttemptSuccessReceipt,
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    provider_health
        .record_provider_success_in_failure_scope(
            receipt,
            failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

pub(crate) async fn run_v3_direct_provider_failure_policy<R: V3ProviderAvailabilityReader>(
    context: &V3DirectProviderFailurePolicyContext<'_, R>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    state: &mut V3DirectProviderFailurePolicyState<'_>,
) -> Result<V3DirectProviderFailurePolicyResult, V3Error01SourceRaised> {
    if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect) {
        let decision = (context.run_error)(
            source,
            V3ErrorActionScope::ProviderInstance {
                provider_id: selected.candidate.provider_id.clone(),
            },
            0,
            false,
            false,
            None,
        );
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
    let request_local_scope =
        crate::provider_failure_runtime_policy::request_local_provider_failure_scope(
            source.source_stage,
            observed_status,
            source
                .external_error
                .as_ref()
                .and_then(|error| error.code.as_deref()),
        );
    let failed_key = candidate_key(&selected.candidate);
    let health_record = if request_local_scope
        == crate::provider_failure_runtime_policy::V3RequestLocalProviderFailureScope::Candidate
    {
        V3ProviderFailureRecord {
            scope_label: failed_key.clone(),
            provider_key: failed_key.clone(),
            state: "request_local_provider_compat".to_string(),
            failure_count: 0,
            cooldown_until_ms: None,
            reason: (!source.message.trim().is_empty()).then(|| source.message.clone()),
        }
    } else {
        record_v3_direct_provider_failure_record(
            context.provider_health,
            context.failure_session_scope,
            selected,
            &source,
            context.now_epoch_ms,
        )?
    };
    let expanded_candidates = match (context.expanded, context.provider_pinned) {
        (Some(expanded), _) => Some(&expanded.candidates),
        (None, true) => None,
        (None, false) => {
            return Err(runtime_source(
                "V3Target09CandidateSetExpanded",
                "routed candidate set missing",
            ))
        }
    };
    let request_local_excluded = context.expanded.map_or_else(
        || {
            if request_local_scope
                == crate::provider_failure_runtime_policy::V3RequestLocalProviderFailureScope::Provider
            {
                expanded_candidates.map_or_else(
                    || BTreeSet::from([failed_key.clone()]),
                    |expanded_candidates| {
                        expanded_candidates
                            .iter()
                            .filter(|candidate| {
                                candidate.provider_id == selected.candidate.provider_id
                            })
                            .map(candidate_key)
                            .collect()
                    },
                )
            } else {
                BTreeSet::from([failed_key.clone()])
            }
        },
        |expanded| {
            crate::provider_failure_runtime_policy::expand_request_local_provider_failure_scope(
                request_local_scope,
                selected,
                expanded,
            )
        },
    );
    state.failed_candidates.extend(request_local_excluded.clone());
    let failed_with_current = state.failed_candidates.clone();
    let mut remaining = expanded_candidates.map_or(0, |expanded_candidates| {
        remaining_available_candidates(
            expanded_candidates,
            context.availability,
            &failed_with_current,
        )
    });
    let mut next_provider_key = expanded_candidates.and_then(|expanded_candidates| {
        first_remaining_available_candidate_key(
            expanded_candidates,
            context.availability,
            &failed_with_current,
        )
    });
    if remaining == 0 {
        if let Some(candidates) = expanded_candidates {
            if candidates.len() > 1 {
                remaining = candidates
                    .iter()
                    .filter(|candidate| {
                        let key = candidate_key(candidate);
                        !failed_with_current.contains(&key)
                            && context
                                .provider_health
                                .availability(
                                    &candidate.provider_id,
                                    Some(&candidate.auth_alias),
                                    Some(&candidate.model_id),
                                    context.now_epoch_ms,
                                )
                                .available
                    })
                    .count();
                if next_provider_key.is_none() {
                    next_provider_key = candidates.iter().find_map(|candidate| {
                        let key = candidate_key(candidate);
                        (!failed_with_current.contains(&key)
                            && context
                                .provider_health
                                .availability(
                                    &candidate.provider_id,
                                    Some(&candidate.auth_alias),
                                    Some(&candidate.model_id),
                                    context.now_epoch_ms,
                                )
                                .available)
                            .then(|| key)
                    });
                }
            }
        }
    }
    let provider_scope = V3ErrorActionScope::ProviderInstance {
        provider_id: selected.candidate.provider_id.clone(),
    };
    let recovery_record = if remaining > 0
        && request_local_scope
            == crate::provider_failure_runtime_policy::V3RequestLocalProviderFailureScope::Provider
    {
        Some(
            context
                .provider_health
                .record_provider_action_failure_in_scope(
                    context.failure_session_scope,
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    &source.code,
                )
                .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?,
        )
    } else {
        None
    };
    let recovery_witness = match recovery_record.as_ref() {
        Some(record) => Some(
            record
                .recovery_witness()
                .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?,
        ),
        None if remaining > 0 => Some(
            routecodex_v3_error::V3Error05RecoveryAdmissionWitness::new(
                context.failure_session_scope.clone(),
                failed_key.clone(),
                source.code.clone(),
                1,
            )
            .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?,
        ),
        None => None,
    };
    let decision = (context.run_error)(
        source.clone(),
        provider_scope,
        remaining,
        false,
        false,
        recovery_witness,
    );
    state
        .trace
        .extend(V3_ERROR_CHAIN_NODE_IDS.iter().take(5).copied());
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ) {
        state.trace.push("V3TargetLocalReselected");
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event: Some(build_v3_direct_provider_failure_observation(
                selected,
                observed_status,
                &source,
                &health_record,
                "switch_provider",
                next_provider_key,
                Some(
                    recovery_record
                        .as_ref()
                        .map_or(0, |record| record.minimum_delay_ms),
                ),
            )),
            // Candidate-scoped request/provider compatibility failures are
            // health-neutral and must reselect immediately without entering
            // the provider action gate.
            retryable_transient: request_local_scope
                == crate::provider_failure_runtime_policy::V3RequestLocalProviderFailureScope::Candidate,
        });
    }
    if matches!(decision.action, V3Error05ExecutionAction::WaitThenRetrySame { .. }) {
        return Err(runtime_source(
            "V3Error05ExecutionDecision",
            "retry_same is not a production provider failure action",
        ));
    }
    if !matches!(decision.action, V3Error05ExecutionAction::ProjectTerminal) {
        return Err(runtime_source(
            "V3Error05ExecutionDecision",
            format!(
                "provider failure produced invalid Error05 action {:?}",
                decision.action
            ),
        ));
    }
    if context.provider_pinned && health_record.state == "cooldown" {
        let mut admission = context
            .provider_health
            .wait_for_provider_action_failure_in_scope(
                context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                &source.code,
            )
            .await
            .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?;
        drop(admission.take_permit());
    }
    let admission = if request_local_scope
        == crate::provider_failure_runtime_policy::V3RequestLocalProviderFailureScope::Candidate
    {
        None
    } else {
        Some(
            context
                .provider_health
                .wait_for_terminal_provider_projection_in_scope(
                    context.failure_session_scope,
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    &source.code,
                )
                .await
                .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?,
        )
    };
    state.trace.push("V3Error06ClientProjected");
    Ok(V3DirectProviderFailurePolicyResult {
        decision,
        retry_selected: None,
        event: Some(build_v3_direct_provider_failure_observation(
            selected,
            observed_status,
            &source,
            &health_record,
            "terminal_default_floor_exhausted",
            None,
            admission.as_ref().map(|admission| admission.minimum_delay_ms),
        )),
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
    let observed_status = source
        .external_error
        .as_ref()
        .and_then(|external| external.status)
        .filter(|external_status| *external_status >= 400)
        .unwrap_or(status);
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
            .and_then(|external| external.status),
        internal_code: source
            .internal_error
            .as_ref()
            .map(|internal| internal.internal_code.to_string()),
        message: source.message.clone(),
        failure_count: health_record.failure_count,
        health_state: health_record.state.clone(),
        cooldown_until_ms: health_record.cooldown_until_ms,
        action: action.to_string(),
        next_provider_key,
        wait_ms,
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
