fn select_v3_preplanned_direct_target(
    target: &V3TargetInterpreter,
    expanded: Option<&routecodex_v3_target::V3Target09CandidateSetExpanded>,
    session_availability: &routecodex_v3_provider_responses::V3ProviderSessionAvailabilityReader,
    provider_health: &V3ProviderFailureRuntimeHealth,
    failed_candidates: &BTreeSet<String>,
    now_epoch_ms: u64,
) -> Result<routecodex_v3_target::V3Target10ConcreteProviderSelected, V3Error01SourceRaised> {
    let expanded = expanded.ok_or_else(|| {
        runtime_source(
            "V3Target09CandidateSetExpanded",
            "preplanned candidate set missing",
        )
    })?;
    select_v3_target_with_session_then_global(
        target,
        expanded.clone(),
        session_availability,
        provider_health,
        failed_candidates,
        now_epoch_ms,
    )
    .map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::TargetPoolExhausted,
            "V3Target10ConcreteProviderSelected",
            "preplanned_target_exhausted",
            format!("{} candidates unavailable", error.attempted_candidates.len()),
        )
    })
}

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

struct V3DirectProviderFailurePolicyResult {
    decision: V3Error05ExecutionDecision,
    retry_selected: Option<Box<routecodex_v3_target::V3Target10ConcreteProviderSelected>>,
    event: Option<V3RuntimeProviderFailureObservation>,
}

struct V3DirectProviderFailurePolicyContext<'ctx, R: V3ProviderAvailabilityReader + ?Sized> {
    failure_session_scope: &'ctx V3ProviderFailureSessionScope,
    provider_health: &'ctx V3ProviderFailureRuntimeHealth,
    hook_registry: &'ctx V3HookRegistry,
    availability: &'ctx R,
    expanded: Option<&'ctx routecodex_v3_target::V3Target09CandidateSetExpanded>,
    provider_pinned: bool,
    now_epoch_ms: u64,
}

struct V3DirectProviderFailurePolicyState<'state> {
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

async fn run_v3_direct_provider_failure_policy<R: V3ProviderAvailabilityReader>(
    context: &V3DirectProviderFailurePolicyContext<'_, R>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    state: &mut V3DirectProviderFailurePolicyState<'_>,
) -> Result<V3DirectProviderFailurePolicyResult, V3Error01SourceRaised> {
    if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect) {
        let decision = context.hook_registry.run_error(
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
        });
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
        && retries_done < V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET;
    let cross_session_revive_admitted = remaining == 0
        && context
            .provider_health
            .store()
            .try_acquire_cross_session_revive(
                context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                context.now_epoch_ms,
            )
            .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error.to_string()))?
            .is_some();
    let same_provider_retry_available =
        ordinary_same_provider_retry_available || cross_session_revive_admitted;
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
    let decision = context.hook_registry.run_error(
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
        });
    }
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenRetrySame { .. }
    ) {
        let retries_done = state.same_candidate_retries.entry(failed_key).or_insert(0);
        *retries_done = retries_done.saturating_add(1);
        state.trace.push(if cross_session_revive_admitted {
            "V3CrossSessionReviveAdmitted"
        } else {
            "V3DefaultFloorBackoffWait"
        });
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
                if cross_session_revive_admitted {
                    "cross_session_revive"
                } else {
                    "retry_provider"
                },
                Some(candidate_key(&selected.candidate)),
                Some(failure_record.minimum_delay_ms),
            )),
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

fn publish_v3_direct_provider_failure_event(
    sink: Option<&V3RuntimeProviderFailureEventSink>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    transport: &str,
    status: Option<u16>,
    provider_failure_events: &[V3RuntimeProviderFailureObservation],
    event: &V3RuntimeProviderFailureObservation,
) {
    if let Some(sink) = sink {
        let observability = build_v3_direct_runtime_observability(
            selected,
            transport,
            status,
            "failed",
            provider_failure_events.to_vec(),
            false,
        );
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

fn build_v3_direct_runtime_observability(
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
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        stream_observation: V3RuntimeStreamObservation,
        runtime_timing: V3RuntimeTimingState,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            stream_observation,
            runtime_timing,
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
                    )
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

fn record_direct_sse_provider_event_json_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
    for frame in frames {
        record_direct_sse_provider_event_json_frame(frame.frame().fields(), stream_observation)?;
    }
    Ok(())
}

fn record_direct_sse_provider_event_json_frame(
    fields: &[SseField],
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name != "data" {
            continue;
        }
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value);
    }
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let event: Value = serde_json::from_str(data).map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.to_string(),
        )
    })?;
    stream_observation
        .record_provider_event_json(&event)
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
}

#[derive(Clone)]
struct V3DirectSseStoplessControlPolicy {
    stopless_center_enabled: bool,
    stopless_control: Option<V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<V3ResponsesDirectStoplessControlScope>,
    request_stopless_state: Option<V3StoplessCenterState>,
    transition_request_id: String,
    transition_updated_at: u64,
    previous_response_id: Option<String>,
    continuation_state: Option<V3ResponsesDirectContinuationState>,
    continuation_scope: Option<V3ResponsesDirectContinuationScope>,
    selected_pin: V3RemoteContinuationPin,
    selected_capability_revision: String,
}

fn wrap_direct_sse_stopless_control_stream(
    source: V3ClientSseStream,
    policy: V3DirectSseStoplessControlPolicy,
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        policy: V3DirectSseStoplessControlPolicy,
        pending: VecDeque<Result<Vec<u8>, V3Error01SourceRaised>>,
        committed_stopless_locator: bool,
        state_transition_done: bool,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            policy,
            pending: VecDeque::new(),
            committed_stopless_locator: false,
            state_transition_done: false,
            done: false,
        },
        |mut state| async move {
            loop {
                if let Some(item) = state.pending.pop_front() {
                    return Some((item, state));
                }
                if state.done {
                    return None;
                }
                match state.source.next().await {
                    Some(Ok(chunk)) => {
                        match transform_direct_sse_stopless_control_chunk(
                            &chunk,
                            &mut state.decoder,
                            &state.policy,
                            &mut state.committed_stopless_locator,
                            &mut state.state_transition_done,
                        ) {
                            Ok(chunks) => {
                                state.pending.extend(chunks.into_iter().map(Ok));
                            }
                            Err(error) => {
                                state.done = true;
                                return Some((Err(error), state));
                            }
                        }
                    }
                    Some(Err(error)) => {
                        if let Err(clear_error) =
                            state.policy.clear_active_control_on_stream_terminal()
                        {
                            state.done = true;
                            return Some((Err(clear_error), state));
                        }
                        state.done = true;
                        return Some((Err(error), state));
                    }
                    None => {
                        let decoder = std::mem::replace(
                            &mut state.decoder,
                            SseIncrementalDecoder::new(SseTransportLimits::default()),
                        );
                        if let Err(error) = decoder
                            .finish()
                            .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
                        {
                            state.done = true;
                            return Some((Err(error), state));
                        }
                        if !state.state_transition_done {
                            if let Err(error) =
                                state.policy.clear_active_control_on_stream_terminal()
                            {
                                state.done = true;
                                return Some((Err(error), state));
                            }
                        }
                        return None;
                    }
                }
            }
        },
    ))
}

fn transform_direct_sse_stopless_control_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    policy: &V3DirectSseStoplessControlPolicy,
    committed_stopless_locator: &mut bool,
    state_transition_done: &mut bool,
) -> Result<Vec<Vec<u8>>, V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
    let mut output = Vec::with_capacity(frames.len());
    for frame in frames {
        let fields = transform_direct_sse_stopless_control_frame(
            frame.frame().fields(),
            policy,
            committed_stopless_locator,
            state_transition_done,
        )?;
        let decoded = build_v3_sse_transport_in_02_from_fields(fields)
            .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
        let validated = build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(decoded)
            .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
        output.push(
            build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&validated).into_bytes(),
        );
    }
    Ok(output)
}

fn transform_direct_sse_stopless_control_frame(
    fields: &[SseField],
    policy: &V3DirectSseStoplessControlPolicy,
    committed_stopless_locator: &mut bool,
    state_transition_done: &mut bool,
) -> Result<Vec<SseField>, V3Error01SourceRaised> {
    let Some(request_state) = policy.request_stopless_state.as_ref() else {
        return Ok(fields.to_vec());
    };
    if !policy.stopless_center_enabled {
        return Ok(fields.to_vec());
    }
    let Some(scope) = policy.stopless_scope.as_ref() else {
        return Ok(fields.to_vec());
    };
    if !scope.has_client_session_scope() {
        return Ok(fields.to_vec());
    }
    let mut event_name = None::<String>;
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name == "event" && event_name.is_none() {
            event_name = Some(value.trim().to_string());
        } else if name == "data" {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value);
        }
    }
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(fields.to_vec());
    }
    let mut event: Value = serde_json::from_str(data).map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.to_string(),
        )
    })?;
    let semantic_event = event_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .or_else(|| event.get("type").and_then(Value::as_str))
        .unwrap_or_default();
    if direct_response_has_provider_tool_call(&event) {
        policy.clear_active_control_on_stream_terminal()?;
        *state_transition_done = true;
        return Ok(fields.to_vec());
    }
    if semantic_event != "response.completed" {
        return Ok(fields.to_vec());
    }
    let Some(response_payload) = event.get("response").cloned() else {
        return Ok(fields.to_vec());
    };
    let outcome = run_v3_responses_direct_stopless_response_hooks(
        response_payload,
        request_state,
        &policy.transition_request_id,
        policy.transition_updated_at,
        V3HubTransportIntent::Sse,
    )?;
    let intercepted = outcome.intercepted;
    let continue_remote = outcome
        .center_state
        .as_ref()
        .is_some_and(V3StoplessCenterState::need_continue);
    policy.apply_response_transition(outcome.center_state)?;
    *state_transition_done = true;
    if intercepted && continue_remote && !*committed_stopless_locator {
        policy.commit_stopless_remote_locator_for_payload(&outcome.payload)?;
        *committed_stopless_locator = true;
    }
    if !intercepted {
        return Ok(fields.to_vec());
    }
    if let Some(object) = event.as_object_mut() {
        object.insert("response".to_string(), outcome.payload);
    }
    let encoded_data = serde_json::to_string(&event).map_err(|error| {
        runtime_source("V3DirectStoplessResp03NoopCliOrTerminalProjected", error)
    })?;
    Ok(replace_sse_data_fields(fields, encoded_data))
}

fn replace_sse_data_fields(fields: &[SseField], data: String) -> Vec<SseField> {
    let mut replaced = false;
    let mut output = Vec::with_capacity(fields.len().max(1));
    for field in fields {
        match field {
            SseField::Named { name, .. } if name == "data" => {
                if !replaced {
                    output.push(SseField::Named {
                        name: "data".to_string(),
                        value: data.clone(),
                    });
                    replaced = true;
                }
            }
            other => output.push(other.clone()),
        }
    }
    if !replaced {
        output.push(SseField::Named {
            name: "data".to_string(),
            value: data,
        });
    }
    output
}

impl V3DirectSseStoplessControlPolicy {
    fn apply_response_transition(
        &self,
        response_state: Option<V3StoplessCenterState>,
    ) -> Result<(), V3Error01SourceRaised> {
        match response_state {
            Some(state) => {
                let Some(control) = self.stopless_control.as_ref() else {
                    return Ok(());
                };
                let Some(scope) = self.stopless_scope.as_ref() else {
                    return Ok(());
                };
                control.store_for_scope(scope, state).map_err(|error| {
                    runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error)
                })
            }
            None => self.clear_active_control_on_stream_terminal(),
        }
    }

    fn clear_active_control_on_stream_terminal(&self) -> Result<(), V3Error01SourceRaised> {
        if self.request_stopless_state.is_none() || !self.stopless_center_enabled {
            return Ok(());
        }
        let (Some(control), Some(scope)) =
            (self.stopless_control.as_ref(), self.stopless_scope.as_ref())
        else {
            return Ok(());
        };
        if !scope.has_client_session_scope() {
            return Ok(());
        }
        control
            .clear_for_scope(scope)
            .map_err(|error| runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error))
    }

    fn commit_stopless_remote_locator_for_payload(
        &self,
        payload: &Value,
    ) -> Result<(), V3Error01SourceRaised> {
        commit_v3_direct_stopless_remote_locator_for_payload(
            payload,
            self.previous_response_id.as_deref(),
            self.continuation_state.as_ref(),
            self.continuation_scope.as_ref(),
            &self.selected_pin,
            &self.selected_capability_revision,
            self.transition_updated_at,
        )
    }
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

fn runtime_source(stage: &'static str, error: impl std::fmt::Display) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        stage,
        "v3_route_target_runtime_failure",
        error.to_string(),
    )
}

struct V3ExactPinAvailabilityExhaustion<'pin> {
    pin: &'pin V3RemoteContinuationPin,
    reason: String,
}

impl V3ExactPinAvailabilityExhaustion<'_> {
    fn decide_error_05(&self, hook_registry: &V3HookRegistry) -> V3Error05ExecutionDecision {
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
        .wait_for_terminal_provider_projection_in_scope(
            failure_session_scope,
            &pin.provider_id,
            Some(&pin.auth_handle_id),
            Some(&pin.model_id),
            "continuation_exact_pin_unavailable",
        )
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
        build_v3_error_06_client_projected_from_v3_error_05(terminal),
        node_trace,
    )
}

fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let decision = hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None);
    let terminal = decision.try_into_terminal().unwrap_or_else(|decision| {
        panic!(
            "nonterminal {:?} Error05 reached generic Direct error projection",
            decision.action
        )
    });
    let projected = build_v3_error_06_client_projected_from_v3_error_05(terminal);
    projected_error_output(projected, node_trace)
}

fn projected_error_output(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
) -> V3ResponsesDirectRuntimeOutput {
    projected_error_output_with_observability(projected, node_trace, None)
}

fn projected_error_output_with_observability(
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

fn relay_handoff_output(
    target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    node_trace: Vec<&'static str>,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
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
                    "message": "V3 Responses Direct selected a Relay-only provider; server must execute Hub Relay instead of projecting this internal handoff"
                }
            })),
        },
        node_trace: node_trace.clone(),
        error_chain: None,
        protocol_relay_handoff: Some(V3ResponsesProtocolRelayHandoff {
            target,
            node_trace,
            provider_failure_events,
        }),
    }
}

fn debug_error_output(
    stage: &'static str,
    error: V3DebugError,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    error_output(
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "v3_debug_failure",
            error.to_string(),
        ),
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
