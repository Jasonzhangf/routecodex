use super::relay_runtime_shared::bind_v3_selected_business_auth_kind;
use super::responses_relay_failures::V3_RELAY_TRANSPORT_HANG_REASON;
use super::*;
use crate::operation_runner::plan_execution::{
    run_v3_plan_execution_operator_with_probes, V3PlanExecutionModePolicy, V3PlanExecutionStop,
    V3PlanExecutionTargetSource,
};
use crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key;
use crate::provider_failure_runtime_policy::{
    admit_v3_selected_target_after_recovery, V3AdmitAfterRecovery,
};
use serde_json::{json, Value};

fn construct_responses_relay_transport_request(
    req_compat: ProviderReqCompat06ProviderCompat,
    request_id: &str,
    target: routecodex_v3_provider_responses::V3ResponsesProviderTarget,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<
    routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest,
    V3ResponsesRelayRuntimeError,
> {
    let stream_intent = (provider_protocol == V3HubProviderWireProtocol::Gemini).then_some(
        match transport_intent {
            V3HubTransportIntent::Json => {
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json
            }
            V3HubTransportIntent::Sse => {
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse
            }
        },
    );
    let (req08, _) = build_v3_provider_req_outbound_08_wire_from_compat_06(
        req_compat,
        request_id,
        target,
        stream_intent,
    )
    .map_err(|error| match error {
        V3ProviderReqOutbound08Error::Provider(error) => {
            V3ResponsesRelayRuntimeError::Provider(error)
        }
        error => V3ResponsesRelayRuntimeError::Target(error.to_string()),
    })?;
    build_v3_provider_req_outbound_09_transport_from_wire(req08, Vec::new())
        .map_err(V3ResponsesRelayRuntimeError::Target)
}

fn build_v3_responses_relay_exhaustion_observability(
    exhaustion: &routecodex_v3_target::V3TargetExhaustion,
    transport_intent: V3HubTransportIntent,
    attempts: usize,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
        execution_mode: "relay".to_string(),
        transport: v3_transport_intent_label(transport_intent).to_string(),
        routing_group_id: Some(exhaustion.route.routing_group_id.clone()),
        route_classification_reason: Some(exhaustion.route.route_classification_reason.clone()),
        pool_id: Some(exhaustion.route.pool_id.clone()),
        response_status: Some("error".to_string()),
        attempts: Some(attempts),
        unavailable_candidates: exhaustion.attempted_candidates.clone(),
        ..V3RuntimeObservability::default()
    }
}

// Compatibility entry for callers that need a single unbounded execution.
// Runtime's bounded refill loop calls the `_with_refill` owner below so it can
// observe one typed Chat Process disposition without widening the public
// output struct.
pub(crate) fn execute_v3_responses_relay_runtime_inner<'a, T: ResponsesTransport + 'a>(
    manifest: &'a V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &'a T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3ResponsesRelayRetryPolicy,
    allow_exhaustion_rescue_probe: bool,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    initial_request_local_excluded_candidates: BTreeSet<String>,
    initial_relay_seeds: V3ResponsesRelayRuntimeSeeds,
) -> std::pin::Pin<
    Box<
        impl std::future::Future<
                Output = Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError>,
            > + Send
            + 'a,
    >,
> {
    Box::pin(async move {
        let chat_process_refill = V3ResponsesRelayRefillSignal::default();
        execute_v3_responses_relay_runtime_inner_with_refill(
            manifest,
            input,
            transport,
            provider_health,
            retry_policy,
            allow_exhaustion_rescue_probe,
            provider_failure_event_sink,
            route_selection_event_sink,
            initial_selected_target,
            initial_expanded,
            initial_request_local_excluded_candidates,
            initial_relay_seeds,
            V3HubInvocationSource::Client,
            chat_process_refill,
        )
        .await
    })
}

// Construct the large Relay state machine outside the caller's poll frame.
// The owner returns only the heap pointer to every caller, including dry-run.
#[inline(never)]
pub(crate) fn execute_v3_responses_relay_runtime_inner_with_refill<
    'a,
    T: ResponsesTransport + 'a,
>(
    manifest: &'a V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &'a T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3ResponsesRelayRetryPolicy,
    allow_exhaustion_rescue_probe: bool,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    initial_request_local_excluded_candidates: BTreeSet<String>,
    initial_relay_seeds: V3ResponsesRelayRuntimeSeeds,
    invocation_source: V3HubInvocationSource,
    chat_process_refill: V3ResponsesRelayRefillSignal,
) -> std::pin::Pin<
    Box<
        impl std::future::Future<
                Output = Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError>,
            > + Send
            + 'a,
    >,
> {
    Box::pin(async move {
        chat_process_refill.clear();
        let observability_accumulator = initial_relay_seeds
            .observability_accumulator
            .unwrap_or_else(V3RuntimeObservabilityAccumulator::start);
        let mut route_policy_pending = initial_relay_seeds.route_policy_pending;
        let route_policy_scope = initial_relay_seeds.route_policy_scope;
        let runtime_timing = observability_accumulator.timing();
        macro_rules! commit_route_policy_if_present {
            () => {{
                if let Some(pending) = route_policy_pending.as_ref() {
                    let now = v3_responses_relay_now_epoch_ms()?;
                    pending
                        .commit_from_manifest(manifest, now)
                        .map_err(V3ResponsesRelayRuntimeError::Target)?;
                }
            }};
        }
        compile_v3_hub_v1_static_registry()
            .map_err(|error| V3ResponsesRelayRuntimeError::StaticRegistry(error.to_string()))?;
        let mut trace = Vec::with_capacity(17);
        let client_response_transport_intent =
            v3_responses_relay_transport_intent_from_stream_field(&input.payload);
        let provider_request_transport_intent = client_response_transport_intent;
        let local_tool_output_ids = find_responses_tool_output_ids(&input.payload)?;
        if input
            .payload
            .get("previous_response_id")
            .is_some_and(|value| !value.is_null())
        {
            return Err(V3ResponsesRelayRuntimeError::ClientInboundCanonical(
                "Responses continuation is retired: previous_response_id is unsupported"
                    .to_string(),
            ));
        }
        let req01 = build_v3_hub_req_inbound_01_client_raw(
            input.payload,
            V3HubEntryProtocol::Responses,
            invocation_source,
            client_response_transport_intent,
        );
        trace.push("V3HubReqInbound01ClientRaw");
        // stage-3 丢弃上下文：保留客户端原始 payload 的 Arc 句柄（ReqInbound02 会用
        // canonical 覆盖 `payload`，该 Arc 仍指向客户端原始值）。
        let projection_drop_context = crate::projection_drop_log::V3ProjectionDropContext::new(
            input.request_id.clone(),
            manifest
                .servers
                .get(&input.server_id)
                .map(|server| server.port.to_string())
                .unwrap_or_default(),
            manifest.debug.projection_drop_log_file.clone(),
            std::sync::Arc::clone(&req01.payload.0),
        );
        let req02 = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(req01)
            .map_err(V3ResponsesRelayRuntimeError::ClientInboundCanonical)?;
        trace.push("V3HubReqInbound02Normalized");
        let request_hook_profile = responses_relay_request_hook_profile(manifest, &input.server_id);
        let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
        let resolve_mode = match initial_expanded.as_ref() {
            Some(expanded) => {
                crate::operation_runner::V3ResolveTargetExecutionMode::CapturedHandoff {
                    opaque_hit: expanded.route.clone(),
                    route_policy_pending: route_policy_pending.clone(),
                    route_policy_scope: route_policy_scope.clone(),
                }
            }
            None => crate::operation_runner::V3ResolveTargetExecutionMode::RelayFresh {
                manifest: std::sync::Arc::new(manifest.clone()),
                server_id: input.server_id.clone(),
                entry_kind: "responses".to_string(),
                endpoint_path: "/v1/responses".to_string(),
                requested_model: None,
                deterministic_sample,
            },
        };
        let (target_resolved_request, resolved_target) =
            match crate::operation_runner::run_v3_resolve_target_operator(
                req02.payload().clone(),
                resolve_mode,
            ) {
                Ok(resolved) => resolved,
                Err(crate::operation_runner::V3ResolveTargetOperatorError::Typed(source)) => {
                    return Err(V3ResponsesRelayRuntimeError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )));
                }
                Err(crate::operation_runner::V3ResolveTargetOperatorError::OperatorFault(
                    fault,
                )) => {
                    return Ok(provider_failure_output(
                        V3ResponsesRelayProviderFailure::from(fault),
                        trace,
                        0,
                    ));
                }
                Err(crate::operation_runner::V3ResolveTargetOperatorError::Runner(error)) => {
                    return Err(V3ResponsesRelayRuntimeError::Target(error.to_string()));
                }
            };
        route_policy_pending = resolved_target.route_policy_pending;
        let target_source = match initial_expanded.clone() {
            Some(expanded) => V3PlanExecutionTargetSource::Expanded(expanded),
            None => V3PlanExecutionTargetSource::OpaqueHit(resolved_target.opaque_hit),
        };
        let mut failed_candidates = initial_request_local_excluded_candidates;
        let mut request_local_busy_candidates = initial_relay_seeds.request_local_busy_candidates;
        let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> =
            None;
        let mut initial_selected_target = initial_selected_target;
        macro_rules! handle_error_before_resp03 {
            ($expr:expr) => {
                match $expr {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(error.into());
                    }
                }
            };
        }
        let allowed_execution_modes = handle_error_before_resp03!(
            allowed_execution_modes_for_relay_server(manifest, &input.server_id,)
        );
        let (execution_planned_request, initial_plan) =
            match run_v3_plan_execution_operator_with_probes(
                target_resolved_request,
                manifest,
                target_source,
                &input.failure_session_scope,
                &provider_health,
                &failed_candidates,
                &request_local_busy_candidates,
                v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                deterministic_sample,
                allow_exhaustion_rescue_probe,
                retry_selected
                    .take()
                    .or_else(|| initial_selected_target.take()),
                V3PlanExecutionModePolicy::DirectEntry {
                    entry_protocol: V3HubEntryProtocol::Responses,
                    allowed_modes: allowed_execution_modes.clone(),
                },
            )
            .await
            {
                Ok(plan) => plan,
                Err(V3PlanExecutionStop::Failed(source)) => {
                    return Err(V3ResponsesRelayRuntimeError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )));
                }
                Err(V3PlanExecutionStop::OperatorFault(fault)) => {
                    return Ok(provider_failure_output(
                        V3ResponsesRelayProviderFailure::from(fault),
                        trace,
                        0,
                    ));
                }
                Err(V3PlanExecutionStop::Exhausted {
                    expanded: exhausted_expanded,
                    exhaustion,
                    source,
                    ..
                }) => {
                    let source = match source {
                        Some(source) => Some(source),
                        None => match crate::provider_failure_runtime_policy::v3_pure_all_busy_exhaustion_source(
                            &exhausted_expanded,
                            &failed_candidates,
                            &request_local_busy_candidates,
                        ) {
                            Ok(source) => source,
                            Err(fault) => {
                                return Ok(provider_failure_output(
                                    V3ResponsesRelayProviderFailure::from(fault),
                                    trace,
                                    0,
                                ))
                            }
                        },
                    };
                    let failure = V3ResponsesRelayProviderFailure {
                        status: 502,
                        provider_status: None,
                        policy_error_type: "selected_target_exhausted".to_string(),
                        policy_error_message: format!(
                            "selected target exhausted after {:?}",
                            exhaustion.attempted_candidates
                        ),
                        provider_id: "none".to_string(),
                        source_stage: "V3Target10ConcreteProviderSelected",
                        observability: Some(build_v3_responses_relay_exhaustion_observability(
                            &exhaustion,
                            client_response_transport_intent,
                            observability_accumulator.attempts(),
                        )),
                        terminal_projection: None,
                        terminal_disposition: None,
                        error_operator_fault: None,
                        failed_attempt_evidence: None,
                        matched_policy: None,
                        response_processing_code: None,
                    };
                    return Ok(provider_failure_output(
                        super::responses_relay_failures::terminalize_v3_responses_relay_provider_failure_with_source(
                            failure, source, None,
                        ),
                        trace,
                        0,
                    ));
                }
            };
        let initial_execution_mode = initial_plan.execution_mode;
        let retained_expanded = initial_plan.expanded;
        failed_candidates.extend(initial_plan.request_local_excluded_candidates);
        request_local_busy_candidates.extend(initial_plan.request_local_busy_candidates);
        let mut initial_admitted = Some((
            initial_plan.selected,
            initial_plan.admission,
            initial_plan.protocol_decision,
        ));
        let mut req02 = req02;
        req02.previous.payload.0 = std::sync::Arc::new(execution_planned_request);
        let request_outcome = {
            compile_v3_hub_relay_request_hooks()
                .run_from_normalized(req02, &request_hook_profile)?
        };
        trace.push("V3HubReqChatProcess04Governed");
        let provider_semantic_body = std::sync::Arc::clone(request_outcome.payload_arc());
        let anthropic_response_projection_context =
            V3AnthropicResponsesProjectionContext::from_chat_canonical_request(
                &provider_semantic_body,
            )
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderWireEncoding(error.to_string())
            })?;
        let request_tool_thinking_enabled = request_outcome.tool_thinking_enabled();
        let request_tool_thinking_turn_context =
            request_outcome.tool_thinking_turn_context().clone();
        let req04 = request_outcome.into_governed();
        let mut req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
            req04,
            initial_execution_mode,
        );
        trace.push("V3HubReqExecution05Planned");
        let mut pending_provider_action_recovery = None;
        let mut _provider_action_permit: Option<V3ProviderActionPermit> = None;
        let mut provider_action_permit_target: Option<routecodex_v3_target::V3TargetCandidate> =
            None;
        let mut same_candidate_retries = BTreeMap::<String, usize>::new();
        let mut last_external_http = None;
        let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
        let request_execution_control = match initial_relay_seeds.request_execution_control {
            Some(control) => control,
            None => {
                crate::nodes::V3RequestExecutionControl::from_manifest(manifest, &input.server_id)
                    .map_err(|error| {
                    V3ResponsesRelayRuntimeError::ExecutionControl(error.to_string())
                })?
            }
        };
        let attempt_budget = request_execution_control.attempt_budget();
        let mut provider_send_attempts = attempt_budget.transport_attempts();
        let shared_retry_policy = retry_policy.as_shared_policy();
        let provider_failure_health = provider_health.clone();
        let failure_context = V3RelayProviderFailurePolicyContext {
            manifest,
            captured_target_09: Some(&retained_expanded),
            failure_session_scope: input.failure_session_scope.clone(),
            provider_health: &provider_failure_health,
            retry_policy: shared_retry_policy,
            deterministic_sample,
        };
        loop {
            let (selected, mut selected_admission, protocol_decision): (
                routecodex_v3_target::V3Target10ConcreteProviderSelected,
                Option<V3RuntimeProviderAdmission>,
                crate::nodes::V3Execution11ProtocolDecision,
            ) = if let Some((selected, admission, protocol_decision)) = initial_admitted.take() {
                (selected, Some(admission), protocol_decision)
            } else {
                let preferred_selected = retry_selected.take();
                match run_v3_plan_execution_operator_with_probes(
                    (*req05.previous.previous.previous.payload.0).clone(),
                    manifest,
                    V3PlanExecutionTargetSource::Expanded(retained_expanded.clone()),
                    &input.failure_session_scope,
                    &provider_health,
                    &failed_candidates,
                    &request_local_busy_candidates,
                    v3_relay_provider_policy_now_epoch_ms()
                        .map_err(V3ResponsesRelayRuntimeError::Target)?,
                    deterministic_sample,
                    allow_exhaustion_rescue_probe,
                    preferred_selected,
                    V3PlanExecutionModePolicy::DirectEntry {
                        entry_protocol: V3HubEntryProtocol::Responses,
                        allowed_modes: allowed_execution_modes.clone(),
                    },
                )
                .await
                {
                    Ok((execution_planned_request, plan)) => {
                        req05.previous.previous.previous.payload.0 =
                            std::sync::Arc::new(execution_planned_request);
                        failed_candidates.extend(plan.request_local_excluded_candidates);
                        request_local_busy_candidates.extend(plan.request_local_busy_candidates);
                        (plan.selected, Some(plan.admission), plan.protocol_decision)
                    }
                    Err(V3PlanExecutionStop::Failed(source)) => {
                        return Err(V3ResponsesRelayRuntimeError::Target(format!(
                            "{}: {}",
                            source.code, source.message
                        )));
                    }
                    Err(V3PlanExecutionStop::OperatorFault(fault)) => {
                        return Ok(provider_failure_output(
                            terminalize_v3_responses_relay_provider_failure(
                                V3ResponsesRelayProviderFailure::from(fault),
                                last_external_http.clone(),
                            ),
                            trace,
                            0,
                        ));
                    }
                    Err(V3PlanExecutionStop::Exhausted {
                        expanded: exhausted_expanded,
                        exhaustion,
                        source,
                        ..
                    }) => {
                        let source = match source {
                            Some(source) => Some(source),
                            None => match crate::provider_failure_runtime_policy::v3_pure_all_busy_exhaustion_source(
                                &exhausted_expanded,
                                &failed_candidates,
                                &request_local_busy_candidates,
                            ) {
                                Ok(source) => source,
                                Err(fault) => {
                                    return Ok(provider_failure_output(
                                        terminalize_v3_responses_relay_provider_failure(
                                            V3ResponsesRelayProviderFailure::from(fault),
                                            last_external_http.clone(),
                                        ),
                                        trace,
                                        0,
                                    ))
                                }
                            },
                        };
                        let failure = V3ResponsesRelayProviderFailure {
                            status: 502,
                            provider_status: None,
                            policy_error_type: "selected_target_exhausted".to_string(),
                            policy_error_message: format!(
                                "selected target exhausted after {:?}",
                                exhaustion.attempted_candidates
                            ),
                            provider_id: "none".to_string(),
                            source_stage: "V3Target10ConcreteProviderSelected",
                            observability: Some(build_v3_responses_relay_exhaustion_observability(
                                &exhaustion,
                                client_response_transport_intent,
                                attempt_budget.transport_attempts(),
                            )),
                            terminal_projection: None,
                            terminal_disposition: None,
                            error_operator_fault: None,
                            failed_attempt_evidence: None,
                            matched_policy: None,
                            response_processing_code: None,
                        };
                        return Ok(provider_failure_output(
                            super::responses_relay_failures::terminalize_v3_responses_relay_provider_failure_with_source(
                                failure,
                                source,
                                last_external_http.clone(),
                            ),
                            trace,
                            0,
                        ));
                    }
                }
            };
            if provider_action_permit_target
                .as_ref()
                .is_some_and(|target| {
                    target.provider_id != selected.candidate.provider_id
                        || target.auth_alias != selected.candidate.auth_alias
                        || target.model_id != selected.candidate.model_id
                })
            {
                drop(_provider_action_permit.take());
                provider_action_permit_target = None;
            }
            attempt_budget.set_transport_attempt_limit(selected.candidate_count);
            if matches!(
                protocol_decision.mode,
                crate::nodes::V3Execution11ProtocolDecisionMode::SameProtocolDirect
            ) {
                let protocol_candidate_keys =
                    match crate::kernel::protocol_candidate_keys_for_decision_mode(
                        &retained_expanded,
                        "responses",
                        &allowed_execution_modes,
                        protocol_decision.mode,
                    ) {
                        Ok(keys) => keys,
                        Err(Ok(source)) => {
                            return Err(V3ResponsesRelayRuntimeError::ExecutionControl(format!(
                                "{}: {}",
                                source.code, source.message
                            )))
                        }
                        Err(Err(fault)) => {
                            return Ok(provider_failure_output(
                                terminalize_v3_responses_relay_provider_failure(
                                    V3ResponsesRelayProviderFailure::from(fault),
                                    last_external_http.clone(),
                                ),
                                trace,
                                0,
                            ));
                        }
                    };
                let mut handoff_trace = trace.clone();
                handoff_trace.push("V3Target10ConcreteProviderSelected");
                handoff_trace.push("V3Execution11ProtocolDecision");
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    terminal_disposition: None,
                    client_body: V3ResponsesRelayClientBody::Json(json!({})),
                    node_trace: handoff_trace.clone(),
                    error_chain: None,
                    observability: None,
                    diagnostic_source: None,
                    diagnostic_cause: None,
                    stream_observation: None,
                    finalized_response: None,
                    provider_snapshots: None,
                    protocol_direct_handoff: Some(V3ResponsesProtocolDirectHandoff {
                        request_payload: req05.governed_payload().clone(),
                        plan: V3ResponsesProtocolExecutionPlan {
                            decision: protocol_decision,
                            node_trace: handoff_trace.clone(),
                            expanded: retained_expanded.clone(),
                            protocol_candidate_keys,
                            request_local_excluded_candidates: failed_candidates.clone(),
                            request_local_busy_candidates: request_local_busy_candidates.clone(),
                            _route_policy_pending: route_policy_pending.clone(),
                            _route_policy_scope: route_policy_scope.clone(),
                        },
                        route_policy_pending: route_policy_pending.clone(),
                        route_policy_scope: route_policy_scope.clone(),
                        node_trace: handoff_trace,
                        provider_failure_events,
                        observability_accumulator: observability_accumulator
                            .with_additional_attempts(provider_send_attempts),
                        request_execution_control,
                    }),
                });
            }
            let selected_target_provider_id = selected.candidate.provider_id.clone();
            let selected_target_interface_id = selected.candidate.interface_id.clone();
            let selected_target_auth_alias = selected.candidate.auth_alias.clone();
            let selected_target_model_id = selected.candidate.model_id.clone();
            let provider_wire_protocol = handle_error_before_resp03!(
                provider_wire_protocol_for_selected_candidate(&selected.candidate)
            );
            let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
                req05.clone(),
                V3HubTargetResolution::Routed,
                selected.candidate.clone(),
            );
            let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
                req06,
                provider_wire_protocol,
            );
            let mut selected_observability = build_v3_relay_observability_from_selected(
                &selected,
                client_response_transport_intent,
            );
            selected_observability.attempts = Some(
                observability_accumulator
                    .attempts()
                    .saturating_add(provider_send_attempts)
                    .saturating_add(provider_failure_events.len())
                    .saturating_add(1),
            );
            selected_observability.provider_failure_events = provider_failure_events.clone();
            if let Some(sink) = route_selection_event_sink.as_ref() {
                sink(&selected_observability);
            }
            macro_rules! handle_provider_request_failure {
                ($error:expr) => {{
                    let failure = provider_request_relay_failure(
                        $error,
                        &selected_target_provider_id,
                        Some(selected_observability.clone()),
                    )?;
                    let terminal_failure = handle_error_before_resp03!(
                        handle_v3_responses_relay_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3ResponsesRelayProviderRetryState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                retry_selected: &mut retry_selected,
                                pending_recovery: &mut pending_provider_action_recovery,
                                provider_failure_events: &mut provider_failure_events,
                                provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                                selected_observability: &selected_observability,
                                trace: &mut trace,
                                last_external_http: &mut last_external_http,
                            },
                        )
                        .await
                    );
                    if let Some(failure) = terminal_failure {
                        return Ok(provider_failure_output(failure, trace, 0));
                    }
                    continue;
                }};
            }
            let req07 = match req07 {
                Ok(req07) => req07,
                Err(error) => {
                    handle_provider_request_failure!(V3ResponsesRelayRuntimeError::ProviderCompat(
                        error
                    ));
                }
            };
            let target =
                handle_error_before_resp03!(provider_target(manifest, req07.selected_target()));
            // 声明必须走上游 SSE 的 provider 契约（如 OpenCode Zen 免费层）会强制
            // provider transport intent 为 SSE，客户端响应格式仍按客户端 intent 投影。
            let upstream_requires_sse = crate::hub_v1::v3_provider_profile_requires_upstream_sse(
                target.compatibility_profile.as_deref(),
            );
            let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {
                Ok(projected) => record_projected_drops(&projection_drop_context, projected),
                Err(error) => {
                    handle_provider_request_failure!(V3ResponsesRelayRuntimeError::ProviderCompat(
                        error
                    ));
                }
            };
            let opencode_zen_tcm_bridge = req_compat.opencode_zen_tcm_bridge.clone();
            let custom_tool_function_binding = req_compat.custom_tool_function_binding().cloned();
            let namespace_registry = req_compat.namespace_registry.clone();
            trace.push("V3HubReqTarget06Resolved");
            trace.push("V3HubReqOutbound07ProviderSemantic");
            trace.push("ProviderReqCompat06ProviderCompat");
            let transport_request = match construct_responses_relay_transport_request(
                req_compat,
                &input.request_id,
                target,
                provider_wire_protocol,
                provider_request_transport_intent,
            ) {
                Ok(request) => request,
                Err(error) => {
                    handle_provider_request_failure!(error);
                }
            };
            trace.push("V3ProviderReqOutbound08WirePayload");
            let transport_request = match bind_v3_selected_business_auth_kind(
                manifest,
                &selected.candidate,
                provider_wire_protocol,
                transport_request,
            ) {
                Ok(transport_request) => transport_request,
                Err(error) => {
                    handle_provider_request_failure!(V3ResponsesRelayRuntimeError::Target(error));
                }
            };
            // 声明契约可以强制 provider transport intent 为 SSE。守卫保留并改为对照该
            // 期望值，这样契约被破坏时仍在本地点出，而不是静默放行。
            let expected_provider_request_transport_intent = if upstream_requires_sse {
                V3HubTransportIntent::Sse
            } else {
                provider_request_transport_intent
            };
            if let Err(error) = validate_v3_responses_relay_provider_request_transport_intent(
                expected_provider_request_transport_intent,
                transport_request.stream_intent(),
            ) {
                handle_provider_request_failure!(error);
            }
            trace.push("V3ProviderReqOutbound09TransportRequest");
            let provider_request_snapshot = transport_request.provider_request_projection();
            if pending_provider_action_recovery.is_some() {
                drop(selected_admission.take());
            }
            if let Some(recovery) = pending_provider_action_recovery.take() {
                match handle_error_before_resp03!(provider_health
                    .wait_for_error05_recovery(&recovery, &selected)
                    .await
                    .map_err(V3ResponsesRelayRuntimeError::ProviderHealth))
                {
                    V3ProviderActionRecoveryTransition::Admitted(mut admission) => {
                        _provider_action_permit = admission.take_permit();
                        provider_action_permit_target = Some(selected.candidate.clone());
                        match admit_v3_selected_target_after_recovery(&selected) {
                            V3AdmitAfterRecovery::Admitted(admission) => {
                                selected_admission = Some(admission)
                            }
                            V3AdmitAfterRecovery::Busy => {
                                let busy_key = v3_relay_provider_candidate_key(&selected.candidate);
                                failed_candidates.insert(busy_key.clone());
                                request_local_busy_candidates.insert(busy_key);
                                drop(_provider_action_permit.take());
                                provider_action_permit_target = None;
                                continue;
                            }
                            V3AdmitAfterRecovery::Failed(reason) => {
                                return Err(V3ResponsesRelayRuntimeError::Target(reason))
                            }
                        }
                        trace.push("V3ProviderActionGateAdmission");
                    }
                    V3ProviderActionRecoveryTransition::Superseded(ticket) => {
                        pending_provider_action_recovery =
                            Some(handle_error_before_resp03!(ticket
                                .recovery_witness()
                                .map_err(V3ResponsesRelayRuntimeError::ProviderHealth)));
                        retry_selected = Some(selected);
                        trace.push("V3ProviderActionGateTerminalReevaluation");
                        continue;
                    }
                    V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket) => {
                        pending_provider_action_recovery =
                            Some(handle_error_before_resp03!(ticket
                                .recovery_witness()
                                .map_err(V3ResponsesRelayRuntimeError::ProviderHealth)));
                        retry_selected = Some(selected);
                        trace.push("V3ProviderActionGateTerminalReevaluation");
                        continue;
                    }
                    V3ProviderActionRecoveryTransition::Consumed(_) => {
                        pending_provider_action_recovery = None;
                        retry_selected = Some(selected);
                        trace.push("V3ProviderActionGateConsumedReevaluation");
                        continue;
                    }
                }
            }
            provider_send_attempts =
                handle_error_before_resp03!(attempt_budget.admit_transport_attempt().map_err(
                    |error| V3ResponsesRelayRuntimeError::ExecutionControl(error.to_string())
                ));
            handle_error_before_resp03!(runtime_timing
                .start_external()
                .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
            let transport_request = match selected_admission.take() {
                Some(admission) => {
                    transport_request.with_pre_acquired_admission(admission.into_lease())
                }
                None => transport_request,
            };
            let transport_result = match tokio::time::timeout(
                v3_relay_transport_response_timeout(manifest, &selected_target_provider_id),
                transport.send(transport_request),
            )
            .await
            {
                Err(_) => Err(V3ProviderError::Transport {
                    request_id: input.request_id.clone(),
                    provider_id: selected_target_provider_id.clone(),
                    reason: V3_RELAY_TRANSPORT_HANG_REASON.to_string(),
                }),
                Ok(result) => result,
            };
            let provider_raw = match transport_result {
                Ok(raw) => raw,
                Err(V3ProviderError::ConcurrencyBusy { .. }) => {
                    handle_error_before_resp03!(runtime_timing
                        .finish_external()
                        .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                    let busy_key = v3_relay_provider_candidate_key(&selected.candidate);
                    failed_candidates.insert(busy_key.clone());
                    request_local_busy_candidates.insert(busy_key);
                    drop(_provider_action_permit.take());
                    provider_action_permit_target = None;
                    continue;
                }
                Err(V3ProviderError::HttpStatus { response }) => {
                    last_external_http = Some(
                        crate::hub_v1::relay_runtime_shared::external_http_witness(&response),
                    );
                    handle_error_before_resp03!(runtime_timing
                        .finish_external()
                        .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                    let mut failure = if let Some(reason) = &response.body_read_failure {
                        let mut failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: response.request_id.clone(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!(
                                    "provider HTTP {} error body read failed: {reason}",
                                    response.status
                                ),
                            },
                            &selected_target_provider_id,
                            Some(selected_observability.clone()),
                        );
                        failure.status = response.status;
                        // The upstream did return an HTTP status; only its error body
                        // could not be read, so the real status still belongs in
                        // `provider_status`.
                        failure.provider_status = Some(response.status);
                        failure
                    } else {
                        provider_http_failure(
                            response.status,
                            &response.body,
                            &selected_target_provider_id,
                            Some(selected_observability.clone()),
                        )
                    };
                    failure.failed_attempt_evidence = Some(
                        build_v3_runtime_provider_failed_attempt_evidence_from_response(
                            provider_send_attempts,
                            Some(provider_request_snapshot.clone()),
                            response.status,
                            &response.headers,
                            &response.body,
                            response.body_read_failure.as_deref(),
                        ),
                    );
                    drop(_provider_action_permit.take());
                    let terminal_failure = handle_error_before_resp03!(
                        handle_v3_responses_relay_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3ResponsesRelayProviderRetryState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                retry_selected: &mut retry_selected,
                                pending_recovery: &mut pending_provider_action_recovery,
                                provider_failure_events: &mut provider_failure_events,
                                provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                                selected_observability: &selected_observability,
                                trace: &mut trace,
                                last_external_http: &mut last_external_http,
                            },
                        )
                        .await
                    );
                    if let Some(failure) = terminal_failure {
                        return Ok(provider_failure_output(failure, trace, 0));
                    }
                    continue;
                }
                Err(error) => {
                    handle_error_before_resp03!(runtime_timing
                        .finish_external()
                        .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                    if let Some(witness) =
                        crate::hub_v1::external_http_witness_from_provider_error(&error)
                    {
                        last_external_http = Some(witness);
                    }
                    let failed_attempt_evidence =
                        build_v3_runtime_provider_failed_attempt_evidence_from_error(
                            provider_send_attempts,
                            Some(provider_request_snapshot.clone()),
                            &error,
                        );
                    let mut failure = provider_runtime_failure(
                        error,
                        &selected_target_provider_id,
                        Some(selected_observability.clone()),
                    );
                    failure.failed_attempt_evidence = failed_attempt_evidence;
                    drop(_provider_action_permit.take());
                    let terminal_failure = handle_error_before_resp03!(
                        handle_v3_responses_relay_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3ResponsesRelayProviderRetryState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                retry_selected: &mut retry_selected,
                                pending_recovery: &mut pending_provider_action_recovery,
                                provider_failure_events: &mut provider_failure_events,
                                provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                                selected_observability: &selected_observability,
                                trace: &mut trace,
                                last_external_http: &mut last_external_http,
                            },
                        )
                        .await
                    );
                    if let Some(failure) = terminal_failure {
                        return Ok(provider_failure_output(failure, trace, 0));
                    }
                    continue;
                }
            };
            // The upstream answered: from this instant its head is real evidence,
            // whatever the body turns out to be. It is recorded before the body is
            // interpreted so a stream whose payload never decodes is never reported
            // as if no response had arrived. A branch below that can read a body
            // replaces this with the fuller witness.
            last_external_http = Some(crate::hub_v1::external_http_witness_head(&provider_raw));
            if provider_raw.body_kind()
                == routecodex_v3_provider_responses::V3ProviderResponseBodyKind::Json
            {
                handle_error_before_resp03!(runtime_timing
                    .finish_external()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
            }
            let provider_status = provider_raw.status();
            selected_observability.provider_status = Some(provider_status);
            let provider_id = provider_raw.provider_id().to_string();
            match provider_raw.into_body() {
                V3ProviderResponseBody::Json(bytes) => {
                    let provider_value: Value = match serde_json::from_slice(&bytes) {
                        Ok(value) => value,
                        Err(error) => {
                            let failure = provider_runtime_failure(
                                V3ProviderError::ResponseBody {
                                    request_id: input.request_id.clone(),
                                    provider_id: selected_target_provider_id.clone(),
                                    reason: format!(
                                        "provider JSON response decode failed: {error}"
                                    ),
                                },
                                &selected_target_provider_id,
                                Some(selected_observability.clone()),
                            );
                            drop(_provider_action_permit.take());
                            let terminal_failure = handle_error_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure,
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_recovery: &mut pending_provider_action_recovery,
                                        provider_failure_events: &mut provider_failure_events,
                                        provider_failure_event_sink: provider_failure_event_sink
                                            .as_ref(),
                                        selected_observability: &selected_observability,
                                        trace: &mut trace,
                                        last_external_http: &mut last_external_http,
                                    },
                                )
                                .await
                            );
                            if let Some(failure) = terminal_failure {
                                return Ok(provider_failure_output(failure, trace, 0));
                            }
                            continue;
                        }
                    };
                    let hook_provider_value =
                        if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                            handle_error_before_resp03!(
                                project_v3_anthropic_message_as_responses_response_with_context(
                                    &provider_value,
                                    &anthropic_response_projection_context,
                                )
                                .map_err(|error| {
                                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                        error.to_string(),
                                    )
                                })
                            )
                        } else {
                            provider_value.clone()
                        };
                    let hook_provider_protocol =
                        if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                            V3HubProviderWireProtocol::Responses
                        } else {
                            provider_wire_protocol
                        };
                    // Complete-attempt success acceptance for the buffered JSON
                    // provider body: a materialized attempt with no deliverable
                    // business content is an internal 502 for the Error chain, not
                    // a normal empty completion.
                    if !crate::hub_v1::v3_provider_attempt_has_deliverable_business_content(
                        hook_provider_protocol,
                        &hook_provider_value,
                    ) {
                        let failure =
                            handle_error_before_resp03!(provider_response_stream_relay_failure(
                                crate::hub_v1::empty_provider_attempt_failure(
                                    hook_provider_protocol
                                ),
                                &input.request_id,
                                &selected_target_provider_id,
                                Some(selected_observability.clone()),
                            ));
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                    last_external_http: &mut last_external_http,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                    let (mut finalized_provider_value, governed_facts) =
                        match run_json_response_hooks_with_invocation_source(
                            V3ResponsesRelayJsonResponseHookInput {
                                session_id: input.failure_session_scope.session_id(),
                                request_id: &input.request_id,
                                provider_value: &hook_provider_value,
                                provider_semantic_body: &provider_semantic_body,
                                manifest,
                                server_id: &input.server_id,
                                provider_id: Some(&selected_target_provider_id),
                                interface_id: Some(&selected_target_interface_id),
                                expected_model_id: &selected_target_model_id,
                                provider_protocol: hook_provider_protocol,
                                source_provider_protocol: provider_wire_protocol,
                                namespace_registry: &namespace_registry,
                                opencode_zen_tcm_bridge: opencode_zen_tcm_bridge.as_ref(),
                                custom_tool_function_binding: custom_tool_function_binding.as_ref(),
                                provider_response_transport_intent: V3HubTransportIntent::Json,
                                tool_thinking_enabled: request_tool_thinking_enabled,
                                tool_thinking_turn_context: &request_tool_thinking_turn_context,
                                compatibility_profile: selected
                                    .candidate
                                    .compatibility_profile
                                    .as_deref(),
                                retain_response_cipher: is_v3_retain_response_cipher(
                                    selected.route.target_plan.len(),
                                    &selected.candidate.model_id,
                                ),
                            },
                            invocation_source,
                            &mut trace,
                        ) {
                            Ok(value) => value,
                            Err(error) if is_v3_responses_provider_response_failure(&error) => {
                                let failure = provider_response_hook_failure(
                                    error,
                                    &selected_target_provider_id,
                                    Some(selected_observability.clone()),
                                );
                                drop(_provider_action_permit.take());
                                let terminal_failure = handle_error_before_resp03!(
                                    handle_v3_responses_relay_provider_failure(
                                        &failure_context,
                                        selected,
                                        failure,
                                        &mut V3ResponsesRelayProviderRetryState {
                                            failed_candidates: &mut failed_candidates,
                                            same_candidate_retries: &mut same_candidate_retries,
                                            retry_selected: &mut retry_selected,
                                            pending_recovery: &mut pending_provider_action_recovery,
                                            provider_failure_events: &mut provider_failure_events,
                                            provider_failure_event_sink:
                                                provider_failure_event_sink.as_ref(),
                                            selected_observability: &selected_observability,
                                            trace: &mut trace,
                                            last_external_http: &mut last_external_http,
                                        },
                                    )
                                    .await
                                );
                                if let Some(failure) = terminal_failure {
                                    return Ok(provider_failure_output(failure, trace, 0));
                                }
                                continue;
                            }
                            Err(error) => handle_error_before_resp03!(Err(error)),
                        };
                    materialize_v3_runtime_input_usage_estimate_from_request(
                        &mut finalized_provider_value,
                        provider_semantic_body.as_ref(),
                    );
                    let attempt_success_receipt =
                        crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt();
                    let _ = (
                        &attempt_success_receipt,
                        &local_tool_output_ids.consumed_ids,
                    );
                    handle_error_before_resp03!(provider_health
                        .record_provider_success_in_failure_scope_for_interface(
                            &attempt_success_receipt,
                            &failure_context.failure_session_scope,
                            &selected_target_provider_id,
                            &selected_target_interface_id,
                            Some(&selected_target_auth_alias),
                            Some(&selected_target_model_id),
                            v3_responses_relay_now_epoch_ms()?,
                        )
                        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderHealth(
                            error.to_string()
                        )));
                    let mut observability = selected_observability;
                    observability.provider_status = Some(provider_status);
                    observability.provider_id = Some(provider_id);
                    observability.transport =
                        v3_transport_intent_label(client_response_transport_intent).to_string();
                    let response_status =
                        read_v3_runtime_response_status(&finalized_provider_value);
                    let response_completed = response_status.as_deref() == Some("completed");
                    observability.finish_reason =
                        read_v3_runtime_finish_reason(&finalized_provider_value)
                            .or_else(|| read_v3_runtime_finish_reason(&provider_value))
                            .or_else(|| {
                                infer_v3_runtime_finish_reason_from_provider_event_json(
                                    Some("response.completed"),
                                    response_status.as_deref(),
                                )
                            });
                    observability.response_status = response_status;
                    observability.usage =
                        extract_v3_runtime_usage_summary(&finalized_provider_value);
                    // Resp03 response-side tool projection.
                    observability.timing = Some(handle_error_before_resp03!(runtime_timing
                        .finish_runtime()
                        .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming)));
                    let max_refills =
                        super::resp_chat_process_03_governed::
                            v3_chat_process_refill_max_consecutive();
                    let disposition =
                        super::resp_chat_process_03_governed::decide_v3_chat_process_refill(
                            &governed_facts.tool_calls,
                            governed_facts.has_source_summary,
                            response_completed,
                            request_execution_control.refill_used(),
                            max_refills,
                        );
                    chat_process_refill.set(disposition);
                    let finalized_response = finalized_provider_value.clone();
                    let client_body = project_v3_responses_relay_client_body(
                        client_response_transport_intent,
                        finalized_provider_value,
                        crate::shared::v3_strip_client_response_id_enabled_for_server(
                            manifest,
                            &input.server_id,
                        ),
                        attempt_budget.clone(),
                    )?;
                    commit_route_policy_if_present!();
                    return Ok(V3ResponsesRelayRuntimeOutput {
                        status: 200,
                        terminal_disposition: None,
                        client_body,
                        node_trace: trace,
                        error_chain: None,
                        observability: Some(observability),
                        diagnostic_source: None,
                        diagnostic_cause: None,
                        stream_observation: None,
                        finalized_response: Some(finalized_response),
                        provider_snapshots: None,
                        protocol_direct_handoff: None,
                    });
                }
                V3ProviderResponseBody::Sse(stream) => {
                    let sse_idle_timeout =
                        crate::hub_v1::relay_runtime_core::v3_provider_sse_idle_timeout(
                            manifest,
                            &selected_target_provider_id,
                        )
                        .map_err(V3ResponsesRelayRuntimeError::Target)?;
                    let stream =
                        crate::hub_v1::relay_runtime_core::guard_v3_provider_sse_attempt_deadline(
                            &input.request_id,
                            &selected_target_provider_id,
                            stream,
                            attempt_budget.residence_deadline(),
                        );
                    let stream_observation = V3RuntimeStreamObservation::default();
                    let provider_value_result =
                    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
                        provider_wire_protocol,
                        crate::hub_v1::relay_runtime_core::guard_v3_provider_sse_idle(
                            &input.request_id,
                            &selected_target_provider_id,
                            stream,
                            sse_idle_timeout,
                        ),
                        &stream_observation,
                        &anthropic_response_projection_context,
                    )
                    .await;
                    handle_error_before_resp03!(runtime_timing
                        .finish_external()
                        .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                    let provider_value = match provider_value_result {
                        Ok(value) => value,
                        Err(error) => {
                            let failure = handle_error_before_resp03!(
                                provider_response_stream_relay_failure(
                                    error,
                                    &input.request_id,
                                    &selected_target_provider_id,
                                    Some(selected_observability.clone()),
                                )
                            );
                            let residence_deadline_error = failure.policy_error_message.contains(
                                "provider SSE attempt exceeded the request residence deadline",
                            );
                            drop(_provider_action_permit.take());
                            let terminal_failure = handle_error_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure.clone(),
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_recovery: &mut pending_provider_action_recovery,
                                        provider_failure_events: &mut provider_failure_events,
                                        provider_failure_event_sink: provider_failure_event_sink
                                            .as_ref(),
                                        selected_observability: &selected_observability,
                                        trace: &mut trace,
                                        last_external_http: &mut last_external_http,
                                    },
                                )
                                .await
                            );
                            let deadline_expired =
                                attempt_budget.residence_deadline() <= std::time::Instant::now();
                            if let Some(failure) = terminal_failure {
                                return Ok(provider_failure_output_with_observation(
                                    failure,
                                    trace,
                                    Some(stream_observation),
                                ));
                            }
                            if residence_deadline_error || deadline_expired {
                                return Ok(provider_failure_output_with_observation(
                                    attach_v3_provider_failure_events_to_failure(
                                        terminalize_v3_responses_relay_provider_failure(
                                            failure,
                                            last_external_http.clone(),
                                        ),
                                        &provider_failure_events,
                                    ),
                                    trace,
                                    Some(stream_observation),
                                ));
                            }
                            continue;
                        }
                    };
                    let hook_provider_protocol =
                        if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                            V3HubProviderWireProtocol::Responses
                        } else {
                            provider_wire_protocol
                        };
                    let (mut finalized_provider_value, governed_facts) =
                        match run_json_response_hooks_with_invocation_source(
                            V3ResponsesRelayJsonResponseHookInput {
                                session_id: input.failure_session_scope.session_id(),
                                request_id: &input.request_id,
                                provider_value: &provider_value,
                                provider_semantic_body: &provider_semantic_body,
                                manifest,
                                server_id: &input.server_id,
                                provider_id: Some(&selected_target_provider_id),
                                interface_id: Some(&selected_target_interface_id),
                                expected_model_id: &selected_target_model_id,
                                provider_protocol: hook_provider_protocol,
                                source_provider_protocol: provider_wire_protocol,
                                namespace_registry: &namespace_registry,
                                opencode_zen_tcm_bridge: opencode_zen_tcm_bridge.as_ref(),
                                custom_tool_function_binding: custom_tool_function_binding.as_ref(),
                                provider_response_transport_intent: V3HubTransportIntent::Sse,
                                tool_thinking_enabled: request_tool_thinking_enabled,
                                tool_thinking_turn_context: &request_tool_thinking_turn_context,
                                compatibility_profile: selected
                                    .candidate
                                    .compatibility_profile
                                    .as_deref(),
                                retain_response_cipher: is_v3_retain_response_cipher(
                                    selected.route.target_plan.len(),
                                    &selected.candidate.model_id,
                                ),
                            },
                            invocation_source,
                            &mut trace,
                        ) {
                            Ok(value) => value,
                            Err(error) if is_v3_responses_provider_response_failure(&error) => {
                                let failure = provider_response_hook_failure(
                                    error,
                                    &selected_target_provider_id,
                                    Some(selected_observability.clone()),
                                );
                                drop(_provider_action_permit.take());
                                let terminal_failure = handle_error_before_resp03!(
                                    handle_v3_responses_relay_provider_failure(
                                        &failure_context,
                                        selected,
                                        failure,
                                        &mut V3ResponsesRelayProviderRetryState {
                                            failed_candidates: &mut failed_candidates,
                                            same_candidate_retries: &mut same_candidate_retries,
                                            retry_selected: &mut retry_selected,
                                            pending_recovery: &mut pending_provider_action_recovery,
                                            provider_failure_events: &mut provider_failure_events,
                                            provider_failure_event_sink:
                                                provider_failure_event_sink.as_ref(),
                                            selected_observability: &selected_observability,
                                            trace: &mut trace,
                                            last_external_http: &mut last_external_http,
                                        },
                                    )
                                    .await
                                );
                                if let Some(failure) = terminal_failure {
                                    return Ok(provider_failure_output(failure, trace, 0));
                                }
                                continue;
                            }
                            Err(error) => handle_error_before_resp03!(Err(error)),
                        };
                    materialize_v3_runtime_input_usage_estimate_from_request(
                        &mut finalized_provider_value,
                        provider_semantic_body.as_ref(),
                    );
                    let attempt_success_receipt =
                        crate::nodes::V3AttemptSuccessReceipt::from_protocol_terminal_attempt();
                    let _ = (
                        &attempt_success_receipt,
                        &local_tool_output_ids.consumed_ids,
                    );
                    handle_error_before_resp03!(provider_health
                        .record_provider_success_in_failure_scope_for_interface(
                            &attempt_success_receipt,
                            &failure_context.failure_session_scope,
                            &selected_target_provider_id,
                            &selected_target_interface_id,
                            Some(&selected_target_auth_alias),
                            Some(&selected_target_model_id),
                            v3_responses_relay_now_epoch_ms()?,
                        )
                        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderHealth(
                            error.to_string()
                        )));
                    stream_observation
                        .record_provider_event_json(&json!({
                            "type":"response.completed",
                            "response": finalized_provider_value.clone()
                        }))
                        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
                    let mut observability = selected_observability;
                    observability.provider_status = Some(provider_status);
                    observability.provider_id = Some(provider_id);
                    observability.transport =
                        v3_transport_intent_label(client_response_transport_intent).to_string();
                    let response_status =
                        read_v3_runtime_response_status(&finalized_provider_value);
                    let response_completed = response_status.as_deref() == Some("completed");
                    observability.finish_reason =
                        read_v3_runtime_finish_reason(&finalized_provider_value)
                            .or_else(|| read_v3_runtime_finish_reason(&provider_value))
                            .or_else(|| {
                                stream_observation
                                    .snapshot()
                                    .ok()
                                    .and_then(|snapshot| snapshot.finish_reason)
                            });
                    if let Some(finish_reason) = observability.finish_reason.as_deref() {
                        stream_observation
                            .record_finish_reason(finish_reason)
                            .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
                    }
                    observability.response_status = response_status;
                    observability.usage =
                        extract_v3_runtime_usage_summary(&finalized_provider_value)
                            .or_else(|| extract_v3_runtime_usage_summary(&provider_value))
                            .or_else(|| {
                                stream_observation
                                    .snapshot()
                                    .ok()
                                    .and_then(|snapshot| snapshot.usage)
                            });
                    // Resp03 response-side tool projection.
                    let timing = handle_error_before_resp03!(runtime_timing
                        .finish_runtime()
                        .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                    observability.timing = Some(timing);
                    stream_observation
                        .record_timing(timing)
                        .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming)?;
                    let client_response_is_sse =
                        client_response_transport_intent == V3HubTransportIntent::Sse;
                    let max_refills =
                        super::resp_chat_process_03_governed::
                            v3_chat_process_refill_max_consecutive();
                    let disposition =
                        super::resp_chat_process_03_governed::decide_v3_chat_process_refill(
                            &governed_facts.tool_calls,
                            governed_facts.has_source_summary,
                            response_completed,
                            request_execution_control.refill_used(),
                            max_refills,
                        );
                    chat_process_refill.set(disposition);
                    let finalized_response = finalized_provider_value.clone();
                    let client_body = project_v3_responses_relay_client_body(
                        client_response_transport_intent,
                        finalized_provider_value,
                        crate::shared::v3_strip_client_response_id_enabled_for_server(
                            manifest,
                            &input.server_id,
                        ),
                        attempt_budget.clone(),
                    )?;
                    commit_route_policy_if_present!();
                    return Ok(V3ResponsesRelayRuntimeOutput {
                        status: 200,
                        terminal_disposition: None,
                        client_body,
                        node_trace: trace,
                        error_chain: None,
                        observability: Some(observability),
                        diagnostic_source: None,
                        diagnostic_cause: None,
                        stream_observation: if client_response_is_sse {
                            Some(stream_observation)
                        } else {
                            None
                        },
                        finalized_response: Some(finalized_response),
                        provider_snapshots: None,
                        protocol_direct_handoff: None,
                    });
                }
            }
        }
    })
}

#[derive(Debug, Default)]
pub(crate) struct V3ResponsesRelayToolOutputIds {
    pub(crate) consumed_ids: Vec<String>,
}

pub(crate) fn find_responses_tool_output_ids(
    payload: &Value,
) -> Result<V3ResponsesRelayToolOutputIds, V3ResponsesRelayRuntimeError> {
    let mut ids = V3ResponsesRelayToolOutputIds::default();
    for item in payload
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if !matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call_output" | "custom_tool_call_output" | "tool_call_output")
        ) {
            continue;
        }
        let id = item
            .get("call_id")
            .or_else(|| item.get("tool_call_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let Some(id) = id else {
            // 命名无配对输出（name+namespace，无 call_id）是合法客户端语义：
            // 它没有可消费的 call 身份，身份由 name/namespace 承载，下游 canonical
            // 保留该身份且不得伪造 call_id。只有既无 call_id 又无 name 才是畸形输入。
            if item
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                continue;
            }
            return Err(V3ResponsesRelayRuntimeError::ClientInboundCanonical(
                "Responses tool output requires call_id".to_string(),
            ));
        };
        if !ids.consumed_ids.iter().any(|existing| existing == id) {
            ids.consumed_ids.push(id.to_owned());
        }
    }
    Ok(ids)
}
