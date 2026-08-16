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
    provider_health
        .record_provider_failure_record(
            failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            Some(&source.message),
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

fn record_v3_direct_provider_success(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    provider_health
        .record_provider_success_in_failure_scope(
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
    if is_v3_retryable_transient_source(&source) {
        return run_v3_direct_transient_failure_policy(context, selected, source, status, state)
            .await;
    }
    let health_record = record_v3_direct_provider_failure_record(
        context.provider_health,
        context.failure_session_scope,
        selected,
        &source,
        context.now_epoch_ms,
    )?;

    let failed_key = candidate_key(&selected.candidate);
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
    let mut failed_with_current = state.failed_candidates.clone();
    failed_with_current.insert(failed_key.clone());
    if source.code == "provider_transport_error" {
        // 连接层错误是 provider/baseurl 级故障：同 provider 的所有 key
        // 共用同一 baseURL，全部排除，避免 key2 失败切 key1 的 thrashing。
        if let Some(expanded_candidates) = expanded_candidates {
            for candidate in expanded_candidates {
                if candidate.provider_id == selected.candidate.provider_id {
                    let key = candidate_key(candidate);
                    failed_with_current.insert(key.clone());
                    state.failed_candidates.insert(key);
                }
            }
        }
    }
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
    let retries_done = *state.same_candidate_retries.get(&failed_key).unwrap_or(&0);
    let ordinary_same_provider_retry_available = health_record.state != "cooldown"
        && remaining == 0
        && (context.provider_pinned
            || selected.default_floor_protected
            || selected.candidate.default_pool_member)
        && retries_done < context.provider_health.default_same_provider_retries()
        // 400/InvalidRequest（客户端请求错误，如 context window 超限）重试结果
        // 必然相同：同一 provider 不重试，直接 reselect 到下一个候选。
        // 注意：HTTP 400 被构造为 ProviderFailure（code=provider_http_400，
        // external_error.status=400），不是 InvalidRequest——必须同时按
        // external status 判定，否则 400 仍会重试同 provider。
        && source.source_kind != V3ErrorSourceKind::InvalidRequest
        && source.external_error.as_ref().and_then(|e| e.status) != Some(400);
    let same_provider_retry_available = ordinary_same_provider_retry_available;
    let recovery_record = if remaining > 0 || same_provider_retry_available {
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
    let decision = (context.run_error)(
        source.clone(),
        provider_scope,
        remaining,
        false,
        same_provider_retry_available,
        match recovery_record.as_ref() {
            Some(record) => Some(
                record
                    .recovery_witness()
                    .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?,
            ),
            None => None,
        },
    );
    state
        .trace
        .extend(V3_ERROR_CHAIN_NODE_IDS.iter().take(5).copied());
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ) {
        let failure_record = recovery_record
            .as_ref()
            .expect("reselect Error05 must carry its recorded recovery witness");
        state.failed_candidates.insert(failed_key);
        state.trace.push("V3TargetLocalReselected");
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event: Some(build_v3_direct_provider_failure_observation(
                selected,
                status,
                &source,
                &health_record,
                "switch_provider",
                next_provider_key,
                Some(failure_record.minimum_delay_ms),
            )),
            retryable_transient: false,
        });
    }
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenRetrySame { .. }
    ) {
        let retries_done = state.same_candidate_retries.entry(failed_key).or_insert(0);
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3DefaultFloorBackoffWait");
        let failure_record = recovery_record
            .as_ref()
            .expect("retry-same Error05 must carry its recorded recovery witness");
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: Some(Box::new(selected.clone())),
            event: Some(build_v3_direct_provider_failure_observation(
                selected,
                status,
                &source,
                &health_record,
                "retry_provider",
                Some(candidate_key(&selected.candidate)),
                Some(failure_record.minimum_delay_ms),
            )),
            retryable_transient: false,
        });
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
    let admission = context
        .provider_health
        .wait_for_terminal_provider_projection_in_scope(
            context.failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            &source.code,
        )
        .await
        .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?;
    state.trace.push("V3Error06ClientProjected");
    Ok(V3DirectProviderFailurePolicyResult {
        decision,
        retry_selected: None,
        event: Some(build_v3_direct_provider_failure_observation(
            selected,
            status,
            &source,
            &health_record,
            "terminal_default_floor_exhausted",
            None,
            Some(admission.minimum_delay_ms),
        )),
        retryable_transient: false,
    })
}

/// 流内/挂起瞬态失败策略（health-neutral + 同 provider 3 次尝试）：
/// HTTP 2xx 后 SSE 流内协议失败（裸 error 事件、空包、首事件超时等）或
/// transport 响应头挂起超时，不写入 provider health（不冷却、不计失败数），
/// 在同一 provider 上直接重试；第 3 次尝试仍失败才回报一次错误事件并切走。
/// 与 relay 侧 request_local_provider_compat 的处理一致：synthetic health
/// record + 直接构造 recovery witness，不触碰 provider health store。
async fn run_v3_direct_transient_failure_policy<R: V3ProviderAvailabilityReader>(
    context: &V3DirectProviderFailurePolicyContext<'_, R>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    state: &mut V3DirectProviderFailurePolicyState<'_>,
) -> Result<V3DirectProviderFailurePolicyResult, V3Error01SourceRaised> {
    let failed_key = candidate_key(&selected.candidate);
    let retries_done = *state.same_candidate_retries.get(&failed_key).unwrap_or(&0);
    let provider_scope = V3ErrorActionScope::ProviderInstance {
        provider_id: selected.candidate.provider_id.clone(),
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
    let mut failed_with_current = state.failed_candidates.clone();
    failed_with_current.insert(failed_key.clone());
    if source.code == "provider_transport_error" {
        // 连接层错误是 provider/baseurl 级故障：同 provider 的所有 key
        // 共用同一 baseURL，全部排除，避免 key2 失败切 key1 的 thrashing。
        if let Some(expanded_candidates) = expanded_candidates {
            for candidate in expanded_candidates {
                if candidate.provider_id == selected.candidate.provider_id {
                    let key = candidate_key(candidate);
                    failed_with_current.insert(key.clone());
                    state.failed_candidates.insert(key);
                }
            }
        }
    }
    let mut remaining = expanded_candidates.map_or(0, |candidates| {
        remaining_available_candidates(candidates, context.availability, &failed_with_current)
    });
    let mut next_provider_key = expanded_candidates.and_then(|candidates| {
        first_remaining_available_candidate_key(
            candidates,
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
    let recovery = build_v3_transient_recovery_witness(
        context.failure_session_scope,
        &failed_key,
        &source.code,
    )
    .map_err(|error| runtime_source("V3Error05RecoveryAdmissionWitness", error))?;
    if retries_done < V3_TRANSIENT_RETRY_BUDGET {
        // 前 2 次失败：静默重试同一 provider，不写 health、不产生事件。
        state
            .same_candidate_retries
            .insert(failed_key.clone(), retries_done + 1);
        state.trace.push("V3DirectTransientRetrySame");
        let decision = (context.run_error)(
            source,
            provider_scope,
            remaining,
            false,
            true,
            Some(recovery),
        );
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: Some(Box::new(selected.clone())),
            event: None,
            retryable_transient: true,
        });
    }
    // 第 3 次尝试仍失败：回报一次错误中心 + 切 provider（无候选则 terminal）。
    // 同时写 session 级短期绕行（30s）：同 session 后续请求绕开该 provider，
    // 避免 health-neutral 导致反复命中同一失败 provider；不触发 15 分钟冷却。
    context
        .provider_health
        .record_provider_transient_bypass_in_session(
            context.failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            Some(&source.message),
            context.now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))?;
    state.failed_candidates.insert(failed_key.clone());
    state.trace.push("V3TargetLocalReselected");
    let decision = (context.run_error)(
        source.clone(),
        provider_scope,
        remaining,
        false,
        false,
        Some(recovery),
    );
    let health_record = build_v3_transient_failure_record(
        &failed_key,
        (retries_done + 1) as u32,
        Some(&source.message),
    );
    Ok(V3DirectProviderFailurePolicyResult {
        decision,
        retry_selected: None,
        event: Some(build_v3_direct_provider_failure_observation(
            selected,
            status,
            &source,
            &health_record,
            if remaining > 0 {
                "switch_provider"
            } else {
                "terminal_transient_exhausted"
            },
            next_provider_key,
            Some(1),
        )),
        retryable_transient: true,
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
            false,
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
    stopless_activation: bool,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: entry_protocol.to_string(),
        execution_mode: "direct".to_string(),
        transport: transport.to_string(),
        routing_group_id: Some(selected.route.routing_group_id.clone()),
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
        stopless_activation,
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
    }
}

fn release_terminal_failure_locator(
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    previous_response_id: Option<&str>,
) -> Result<(), String> {
    let (Some(state), Some(response_id)) = (continuation_state, previous_response_id) else {
        return Ok(());
    };
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    if !store.release(response_id) {
        return Err(format!(
            "terminal failure locator {response_id} was not present at Resp04 release"
        ));
    }
    Ok(())
}

/// Exact-pin availability remains fail-fast in the adjacent stream helper:
/// `V3ExactPinAvailabilityExhaustion` emits `continuation_exact_pin_unavailable`.
include!("direct_runtime_helpers_stream.rs");
