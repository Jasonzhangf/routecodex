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

pub(crate) struct V3DirectProviderFailurePolicyContext<'ctx, R: V3ProviderAvailabilityReader + ?Sized> {
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
    let _revive_admitted = context
        .provider_health
        .try_acquire_cross_session_revive(
            context.failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            context.now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthState", error))?;
    if is_v3_retryable_transient_source(&source) {
        return run_v3_direct_transient_failure_policy(context, selected, source, status, state)
            .await;
    }
    let health_record = record_v3_direct_provider_failure_record(context.provider_health, context.failure_session_scope, selected, &source, context.now_epoch_ms)?;

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
        remaining_available_candidates(expanded_candidates, context.availability, &failed_with_current)
    });
    let mut next_provider_key = expanded_candidates.and_then(|expanded_candidates| {
        first_remaining_available_candidate_key(expanded_candidates, context.availability, &failed_with_current)
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
    context
        .provider_health
        .try_acquire_cross_session_revive(
            context.failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            context.now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthState", error))?;
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
        first_remaining_available_candidate_key(candidates, context.availability, &failed_with_current)
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
        .record_provider_transient_bypass_in_session(context.failure_session_scope, &selected.candidate.provider_id, Some(&selected.candidate.auth_alias), Some(&selected.candidate.model_id), Some(&source.message), context.now_epoch_ms)
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
    let health_record = build_v3_transient_failure_record(&failed_key, (retries_done + 1) as u32, Some(&source.message));
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
    transport: &str,
    status: Option<u16>,
    provider_failure_events: &[V3RuntimeProviderFailureObservation],
    event: &V3RuntimeProviderFailureObservation,
    attempts: usize,
) {
    if let Some(sink) = sink {
        let mut observability = build_v3_direct_runtime_observability(
            selected,
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
    transport: &str,
    provider_status: Option<u16>,
    response_status: &str,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    stopless_activation: bool,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
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

struct V3DirectSseRemoteContinuationPolicy {
    state: V3ResponsesDirectContinuationState,
    scope_key: V3RemoteContinuationScopeKey,
    previous_response_id: Option<String>,
    selected_pin: V3RemoteContinuationPin,
    selected_capability_revision: String,
    now_epoch_ms: u64,
    committed_pending: bool,
}

fn wrap_direct_sse_remote_continuation_stream(
    source: V3ClientSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    policy: V3DirectSseRemoteContinuationPolicy,
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        observation_state: V3SseRemoteContinuationObservationState,
        policy: V3DirectSseRemoteContinuationPolicy,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            observation_state,
            policy,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            match state.source.next().await {
                Some(Ok(chunk)) => {
                    let result = state
                        .policy
                        .commit_observed_pending(&state.observation_state)
                        .map(|()| chunk);
                    if result.is_err() {
                        state.done = true;
                    }
                    Some((result, state))
                }
                Some(Err(error)) => {
                    state.done = true;
                    Some((Err(error), state))
                }
                None => match state.policy.release_terminal_previous() {
                    Ok(()) => None,
                    Err(error) => {
                        state.done = true;
                        Some((Err(error), state))
                    }
                },
            }
        },
    ))
}

fn wrap_direct_sse_provider_event_json_observation_stream(
    source: V3ClientSseStream,
    stream_observation: V3RuntimeStreamObservation,
    runtime_timing: V3RuntimeTimingState,
    strip_client_response_id: bool,
    retain_response_cipher: bool,
) -> V3ClientSseStream {
    wrap_direct_sse_provider_event_json_observation_stream_with_compat(
        source,
        stream_observation,
        runtime_timing,
        strip_client_response_id,
        retain_response_cipher,
        false,
    )
}

pub(crate) fn wrap_direct_sse_provider_event_json_observation_stream_with_compat(
    source: V3ClientSseStream,
    stream_observation: V3RuntimeStreamObservation,
    runtime_timing: V3RuntimeTimingState,
    strip_client_response_id: bool,
    retain_response_cipher: bool,
    deepseek_console_go: bool,
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        stream_observation: V3RuntimeStreamObservation,
        runtime_timing: V3RuntimeTimingState,
        strip_client_response_id: bool,
        retain_response_cipher: bool,
        deepseek_console_go: bool,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            stream_observation,
            runtime_timing,
            strip_client_response_id,
            retain_response_cipher,
            deepseek_console_go,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            match state.source.next().await {
                Some(Ok(chunk)) => {
                    let result = record_direct_sse_provider_event_json_chunk(
                        &chunk,
                        &mut state.decoder,
                        &state.stream_observation,
                        state.strip_client_response_id,
                        state.retain_response_cipher,
                        state.deepseek_console_go,
                    )
                    .map(|out| out.unwrap_or(chunk));
                    if result.is_err() {
                        state.done = true;
                    }
                    Some((result, state))
                }
                Some(Err(error)) => {
                    state.done = true;
                    Some((Err(error), state))
                }
                None => {
                    state.done = true;
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        SseIncrementalDecoder::new(SseTransportLimits::default()),
                    );
                    match decoder
                        .finish()
                        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
                    {
                        Ok(()) if state.runtime_timing.is_finished().unwrap_or(false) => None,
                        Ok(()) => match state.runtime_timing.finish_external() {
                            Ok(()) => None,
                            Err(error) => {
                                Some((Err(runtime_source("V3RuntimeTimingExternal", error)), state))
                            }
                        },
                        Err(error) => Some((Err(error), state)),
                    }
                }
            }
        },
    ))
}

/// Usage-observation-only SSE wrap：只把 provider SSE 事件 JSON 写入
/// 观测；开启 strip_client_response_id 时，把事件 data 中嵌套
/// `response.id` 替换为空串后重编码返回（客户端拿不到 previous_response_id）。
fn record_direct_sse_provider_event_json_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    stream_observation: &V3RuntimeStreamObservation,
    strip_client_response_id: bool,
    retain_response_cipher: bool,
    deepseek_console_go: bool,
) -> Result<Option<Vec<u8>>, V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
    if frames.is_empty() {
        return Ok(None);
    }
    // 所有改写都关闭：纯 usage 观测，透传原 chunk（direct 字节保真路径）。
    if !strip_client_response_id && retain_response_cipher && !deepseek_console_go {
        for frame in &frames {
            record_direct_sse_provider_event_json_frame(frame.frame().fields(), stream_observation)?;
        }
        return Ok(None);
    }
    let mut rewritten = Vec::new();
    let mut any_rewritten = false;
    for frame in frames {
        record_direct_sse_provider_event_json_frame(frame.frame().fields(), stream_observation)?;
        // 帧改写优先级：密文剥离（唯一 hook）优先；同一帧极少同时携带
        // response.id 与 encrypted_content（created/completed 帧 vs reasoning 帧），
        // 冲突帧只做密文剥离。
        let frame_data = if !retain_response_cipher {
            rewritten_v3_sse_frame_data_cipher(frame.frame())
        } else {
            None
        };
        let frame_data = match frame_data {
            Some(pair) => Some(pair),
            None if deepseek_console_go => {
                rewritten_v3_sse_frame_data_tool_call_compat(frame.frame())
                    .or_else(|| {
                        if strip_client_response_id {
                            rewritten_v3_sse_frame_data_response_id(frame.frame())
                        } else {
                            None
                        }
                    })
            }
            None if strip_client_response_id => {
                rewritten_v3_sse_frame_data_response_id(frame.frame())
            }
            None => None,
        };
        if let Some((event_name, data)) = frame_data {
            if !event_name.is_empty() {
                rewritten.extend_from_slice(b"event: ");
                rewritten.extend_from_slice(event_name.as_bytes());
                rewritten.push(b'\n');
            }
            rewritten.extend_from_slice(b"data: ");
            rewritten.extend_from_slice(data.as_bytes());
            rewritten.push(b'\n');
            rewritten.push(b'\n');
            any_rewritten = true;
        } else {
            rewritten.extend_from_slice(
                build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame).as_bytes(),
            );
        }
    }
    if any_rewritten {
        Ok(Some(rewritten))
    } else {
        Ok(None)
    }
}

/// 若帧 data JSON 中存在 Codex 密文字段（encrypted_content 以 rsn_/gAAAA 开头），
/// 用唯一剥离 hook（apply_v3_response_cipher_policy）移除后返回 (event 名, 改写后 data)；
/// 未改写返回 None。retain=false（非单 gpt provider）时由调用方保证进入此分支。
fn rewritten_v3_sse_frame_data_cipher(
    frame: &SseTransportIn02DecodedFrame,
) -> Option<(String, String)> {
    let mut event_name = String::new();
    let mut rewritten_data = None;
    for field in frame.fields() {
        let SseField::Named { name, value } = field else {
            continue;
        };
        match name.as_str() {
            "event" => event_name = value.clone(),
            "data" if !value.is_empty() => {
                let Ok(mut parsed) = serde_json::from_str::<Value>(value.as_str()) else {
                    continue;
                };
                let original = parsed.clone();
                routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut parsed, false);
                // 用 Value 相等比较（键序无关），避免 serde_json 重排键序导致
                // 无密文帧也被误判改写（direct SSE 字节保真）。
                if parsed != original {
                    rewritten_data = serde_json::to_string(&parsed).ok();
                }
            }
            _ => {}
        }
    }
    rewritten_data.map(|data| (event_name, data))
}

/// DeepSeek Console Go 响应 SSE 帧回射：`response.output_item.added/done` 事件
/// 中 `item.type=function_call`（name≠apply_patch）回射为 `custom_tool_call`，
/// 并把 `arguments`（`{"input":"<raw>"}` JSON 字符串）解包回 `input` 原始字符串。
/// 客户端声明的是 custom 工具形态，必须回射否则客户端不执行、下一轮历史缺
/// output（孤儿 call）触发上游 400。
fn rewritten_v3_sse_frame_data_tool_call_compat(
    frame: &SseTransportIn02DecodedFrame,
) -> Option<(String, String)> {
    let mut event_name = String::new();
    let mut rewritten_data = None;
    for field in frame.fields() {
        let SseField::Named { name, value } = field else {
            continue;
        };
        match name.as_str() {
            "event" => event_name = value.clone(),
            "data" if !value.is_empty() => {
                let Ok(mut parsed) = serde_json::from_str::<Value>(value.as_str()) else {
                    continue;
                };
                let Some(item) = parsed.get("item").cloned() else {
                    continue;
                };
                // 与 JSON 响应侧复用同一个 compat 函数：构造 {"output":[item]}
                // 交给 apply_deepseek_console_go_response_compat 回射，再取回 item。
                let compat = provider_compat_core::apply_deepseek_console_go_response_compat(
                    json!({"output": [item]}),
                );
                let Some(rewritten_item) = compat
                    .get("output")
                    .and_then(Value::as_array)
                    .and_then(|output| output.first())
                else {
                    continue;
                };
                if rewritten_item == parsed.get("item").unwrap_or(&Value::Null) {
                    continue;
                }
                if let Some(object) = parsed.as_object_mut() {
                    object.insert("item".to_string(), rewritten_item.clone());
                }
                rewritten_data = serde_json::to_string(&parsed).ok();
            }
            _ => {}
        }
    }
    rewritten_data.map(|data| (event_name, data))
}

/// 若帧 data 中的 `response.id` 被替换，返回 (event 名, 改写后 data)；
/// 未改写返回 None。
fn rewritten_v3_sse_frame_data_response_id(
    frame: &SseTransportIn02DecodedFrame,
) -> Option<(String, String)> {
    let mut event_name = String::new();
    let mut rewritten_data = None;
    for field in frame.fields() {
        let SseField::Named { name, value } = field else {
            continue;
        };
        match name.as_str() {
            "event" => event_name = value.clone(),
            "data" if !value.is_empty() => {
                let Ok(mut parsed) = serde_json::from_str::<Value>(value.as_str()) else {
                    continue;
                };
                if crate::shared::strip_v3_response_id_from_json_body(&mut parsed) {
                    rewritten_data = serde_json::to_string(&parsed).ok();
                }
            }
            _ => {}
        }
    }
    rewritten_data.map(|data| (event_name, data))
}

fn record_direct_sse_provider_event_json_frame(
    fields: &[SseField],
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    record_v3_provider_sse_json_frame(fields, stream_observation)
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
}

impl V3DirectSseRemoteContinuationPolicy {
    fn commit_observed_pending(
        &mut self,
        observation_state: &V3SseRemoteContinuationObservationState,
    ) -> Result<(), V3Error01SourceRaised> {
        if self.committed_pending {
            return Ok(());
        }
        let Some(response_id) = observation_state
            .pending_response_id()
            .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?
        else {
            return Ok(());
        };
        let locator = V3RemoteContinuationLocator::new_direct(
            response_id,
            self.scope_key.clone(),
            self.selected_pin.clone(),
            self.selected_capability_revision.clone(),
            self.now_epoch_ms,
            self.now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
        );
        let input = V3RemoteContinuationCommitInput::locator_only(locator);
        let mut store = self
            .state
            .store
            .lock()
            .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
        let commit = match self.previous_response_id.as_deref() {
            Some(previous_response_id) => store.rebind_for_resp04(previous_response_id, input),
            None => store.commit(input),
        };
        commit.map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
        self.committed_pending = true;
        self.previous_response_id = None;
        Ok(())
    }

    fn release_terminal_previous(&mut self) -> Result<(), V3Error01SourceRaised> {
        if self.committed_pending {
            return Ok(());
        }
        let Some(previous_response_id) = self.previous_response_id.take() else {
            return Ok(());
        };
        let mut store = self
            .state
            .store
            .lock()
            .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
        if !store.release(&previous_response_id) {
            return Err(runtime_source(
                "V3HubRespContinuation04Committed",
                format!(
                    "terminal locator {previous_response_id} was not present at Resp04 release"
                ),
            ));
        }
        Ok(())
    }
}

fn capability_revision_for_pin(
    manifest: &V3Config05ManifestPublished,
    pin: &V3RemoteContinuationPin,
) -> Result<String, String> {
    let provider = manifest.providers.get(&pin.provider_id).ok_or_else(|| {
        format!(
            "provider {} is absent for capability revision",
            pin.provider_id
        )
    })?;
    let model = provider.models.get(&pin.model_id).ok_or_else(|| {
        format!(
            "provider {} model {} is absent for capability revision",
            pin.provider_id, pin.model_id
        )
    })?;
    Ok(format!(
        "provider={};type={};model={};wire={};capabilities={};streaming={};thinking={};thinking_mode={:?};max_tokens={:?};max_context_tokens={:?};provider_features={:?};model_features={:?}",
        provider.id,
        provider.provider_type,
        model.id,
        model.wire_name,
        model.capabilities.join(","),
        model.supports_streaming,
        model.supports_thinking,
        model.thinking,
        model.max_tokens,
        model.max_context_tokens,
        provider.features,
        model.features,
    ))
}

pub(crate) fn runtime_source(stage: &'static str, error: impl std::fmt::Display) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(V3ErrorSourceKind::RuntimeFailure, stage, "v3_route_target_runtime_failure", error.to_string())
}

struct V3ExactPinAvailabilityExhaustion<'pin> {
    pin: &'pin V3RemoteContinuationPin,
    reason: String,
}

impl V3ExactPinAvailabilityExhaustion<'_> {
    fn decide_error_05(&self, hook_registry: &V3HookRegistry) -> V3Error05ExecutionDecision {
        // 例外证明：`previous_response_id` exact-pin 的 continuation 必须续到
        // 同一 provider/model（同 provider 才能续 remote continuation），因此
        // pin 不可用时不存在任何可切候选（candidates_remaining=0、default 池
        // 不可用、无同 provider retry 均是 pin 约束下的必然，而非路由决策）。
        // 该决策仍须通过 `try_into_terminal` 的候选耗尽 gate 才能投影 Error06。
        let source = build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3HubReqTarget06Resolved",
            "continuation_exact_pin_unavailable",
            &self.reason,
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(503),
                code: Some("continuation_exact_pin_unavailable".to_string()),
                provider_id: Some(self.pin.provider_id.clone()),
                upstream_request_id: None,
                message: Some(self.reason.clone()),
            },
        );
        hook_registry.run_error(
            source,
            V3ErrorActionScope::CanonicalModel {
                provider_id: self.pin.provider_id.clone(),
                model_id: self.pin.model_id.clone(),
            },
            0,
            false,
            false,
            None,
        )
    }
}

async fn exact_pin_unavailable_output(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    pin: &V3RemoteContinuationPin,
    previous_response_id: Option<&str>,
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    reason: String,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let proof = V3ExactPinAvailabilityExhaustion { pin, reason };
    let decision = proof.decide_error_05(hook_registry);
    let terminal = match decision.try_into_terminal() {
        Ok(terminal) => terminal,
        Err(decision) => {
            return error_output(
                runtime_source(
                    "V3Error05ExecutionDecision",
                    format!(
                        "exact-pin availability proof produced nonterminal {:?} Error05",
                        decision.action
                    ),
                ),
                node_trace,
                hook_registry,
            )
        }
    };
    match provider_health
        .wait_for_terminal_provider_projection_in_scope(failure_session_scope, &pin.provider_id, Some(&pin.auth_handle_id), Some(&pin.model_id), "continuation_exact_pin_unavailable")
        .await
    {
        Ok(_) => {}
        Err(error) => {
            return error_output(
                runtime_source("V3ProviderActionGate", error),
                node_trace,
                hook_registry,
            )
        }
    }
    if let (Some(state), Some(response_id)) = (continuation_state, previous_response_id) {
        let release = state
            .store
            .lock()
            .map_err(|error| error.to_string())
            .map(|mut store| store.release(response_id));
        match release {
            Ok(true) => {}
            Ok(false) => {
                return error_output(
                    runtime_source(
                        "V3HubReqContinuation03Classified",
                        format!("terminal exact-pin locator {response_id} was not present"),
                    ),
                    node_trace,
                    hook_registry,
                )
            }
            Err(error) => {
                return error_output(
                    runtime_source("V3HubReqContinuation03Classified", error),
                    node_trace,
                    hook_registry,
                )
            }
        }
    }
    projected_error_output(
        V3ErrorHandlingCenter::project_terminal_decision(terminal),
        node_trace,
    )
}

pub(crate) fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    assert!(
        source.source_kind != V3ErrorSourceKind::ProviderFailure,
        "error_output must not project ProviderFailure with hardcoded exhaustion; \
         provider failures require caller-owned route/default availability proof"
    );
    let decision = hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None);
    let projected = V3ErrorHandlingCenter::project_terminal(decision);
    projected_error_output(projected, node_trace)
}

pub(crate) fn error_output_with_observability(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    assert!(
        source.source_kind != V3ErrorSourceKind::ProviderFailure,
        "error_output must not project ProviderFailure with hardcoded exhaustion; \
         provider failures require caller-owned route/default availability proof"
    );
    let decision = hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None);
    let projected = V3ErrorHandlingCenter::project_terminal(decision);
    projected_error_output_with_observability(projected, node_trace, observability)
}

fn projected_error_output(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
) -> V3ResponsesDirectRuntimeOutput {
    projected_error_output_with_observability(projected, node_trace, None)
}

pub(crate) fn projected_error_output_with_observability(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability,
        stream_observation: None,
        client_payload: V3Resp15ClientPayload {
            status: projected.status,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(projected.body),
        },
        node_trace,
        error_chain: Some(projected.chain.to_vec()),
        protocol_relay_handoff: None,
    }
}

pub(crate) fn relay_handoff_output(
    target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: BTreeSet<String>,
    node_trace: Vec<&'static str>,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    observability_accumulator: V3RuntimeObservabilityAccumulator,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability: None,
        stream_observation: None,
        client_payload: V3Resp15ClientPayload {
            status: 500,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(json!({
                "error": {
                    "code": "protocol_relay_handoff_unconsumed",
                    "message": "V3 Responses Direct selected a Relay target; server must consume the typed handoff side-channel"
                }
            })),
        },
        node_trace: node_trace.clone(),
        error_chain: None,
        protocol_relay_handoff: Some(V3ResponsesProtocolRelayHandoff {
            target,
            expanded,
            request_local_excluded_candidates,
            node_trace,
            provider_failure_events,
            observability_accumulator,
        }),
    }
}

fn debug_error_output(
    stage: &'static str,
    error: V3DebugError,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    error_output(
        build_v3_error_01_source_raised(V3ErrorSourceKind::RuntimeFailure, stage, "v3_debug_failure", error.to_string()),
        vec![stage],
        hook_registry,
    )
}

fn client_payload_debug_value(payload: &V3Resp15ClientPayload) -> Value {
    match &payload.body {
        V3ClientBody::Json(value) => value.clone(),
        V3ClientBody::Bytes(bytes) => json!({
            "body_kind": "bytes",
            "byte_len": bytes.len()
        }),
        V3ClientBody::Sse(_) => json!({
            "body_kind": "sse_stream"
        }),
    }
}

struct V3RuntimeAttemptAvailability<'a, R> {
    base: &'a R,
    failed_candidates: &'a BTreeSet<String>,
}

impl<R: V3ProviderAvailabilityReader> V3ProviderAvailabilityReader
    for V3RuntimeAttemptAvailability<'_, R>
{
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self
            .base
            .availability(provider_id, auth_alias, model_id, now_ms);
        let key = availability_key(provider_id, auth_alias, model_id);
        if self.failed_candidates.contains(&key) {
            projection.available = false;
            projection
                .blocked_scopes
                .push(format!("request_failed:{key}"));
        }
        projection
    }
}

fn candidate_key(candidate: &V3TargetCandidate) -> String {
    availability_key(
        &candidate.provider_id,
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

fn availability_key(provider_id: &str, auth_alias: Option<&str>, model_id: Option<&str>) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or(""),
        model_id.unwrap_or("")
    )
}

fn remaining_available_candidates<R: V3ProviderAvailabilityReader>(
    candidates: &[V3TargetCandidate],
    availability: &R,
    failed_candidates: &BTreeSet<String>,
) -> usize {
    let attempt_availability = V3RuntimeAttemptAvailability {
        base: availability,
        failed_candidates,
    };
    candidates
        .iter()
        .filter(|candidate| {
            attempt_availability
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    0,
                )
                .available
        })
        .count()
}

fn first_remaining_available_candidate_key<R: V3ProviderAvailabilityReader>(
    candidates: &[V3TargetCandidate],
    availability: &R,
    failed_candidates: &BTreeSet<String>,
) -> Option<String> {
    let attempt_availability = V3RuntimeAttemptAvailability {
        base: availability,
        failed_candidates,
    };
    candidates
        .iter()
        .find(|candidate| {
            attempt_availability
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    0,
                )
                .available
        })
        .map(candidate_key)
}

fn require_static_hooks(hook_registry: &V3HookRegistry) {
    for hook in [
        "ResponsesDirectRouteHook",
        "ResponsesDirectRequestProjectionHook",
        "ResponsesDirectProviderTransportHook",
        "ResponsesDirectResponseProjectionHook",
        "ResponsesDirectErrorHook",
    ] {
        assert!(
            hook_registry.require_hook(hook),
            "missing static hook {hook}"
        );
    }
}

pub(crate) fn direct_runtime_allowed_execution_modes(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Vec<String> {
    manifest
        .servers
        .get(server_id)
        .and_then(|server| server.execution.as_ref())
        .map(|execution| execution.allowed_modes.clone())
        .filter(|modes| !modes.is_empty())
        .unwrap_or_else(|| vec!["direct".to_string()])
}

fn total_attempts(
    accumulator: &V3RuntimeObservabilityAccumulator,
    current_leg_attempts: usize,
) -> usize {
    accumulator
        .attempts()
        .saturating_add(current_leg_attempts)
}

fn validate_initial_direct_plan(
    has_previous_response_id: bool,
    has_initial_target: bool,
    has_initial_protocol_decision: bool,
) -> Result<(), &'static str> {
    if has_previous_response_id && has_initial_target {
        return Err("direct continuation must be resolved from Req03 owner store, not from a non-continuation preselected target");
    }
    if has_initial_target && !has_initial_protocol_decision {
        return Err("preselected direct target requires an initial protocol execution decision");
    }
    Ok(())
}
