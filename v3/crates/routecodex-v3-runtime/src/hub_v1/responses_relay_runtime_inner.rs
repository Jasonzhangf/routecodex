use super::responses_relay_failures::V3_RELAY_TRANSPORT_HANG_REASON;
use super::web_search_hop::store_v3_responses_relay_web_search_state;
use super::web_search_sidecar::execute_web_search_through_hooks_sidecar;
use super::*;
use crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key;
use crate::provider_failure_runtime_policy::{
    admit_v3_selected_target_after_recovery, V3AdmitAfterRecovery,
};
use futures_util::StreamExt;
use serde_json::{json, Value};

pub(super) async fn execute_v3_responses_relay_runtime_resident<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    mut input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    server_tool_state: Option<V3ResponsesRelayServerToolExecution<'_>>,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3ResponsesRelayRetryPolicy,
    allow_exhaustion_rescue_probe: bool,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    initial_request_local_excluded_candidates: BTreeSet<String>,
    initial_observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    request_execution_control: crate::nodes::V3RequestExecutionControl,
    initial_relay_seeds: V3ResponsesRelayRuntimeSeeds,
    entry_origin: V3RelayEntryOrigin,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let observability_accumulator =
        initial_observability_accumulator.unwrap_or_else(V3RuntimeObservabilityAccumulator::start);
    let route_policy_pending = initial_relay_seeds.route_policy_pending;
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
            "Responses continuation is retired: previous_response_id is unsupported".to_string(),
        ));
    }
    apply_v3_responses_relay_web_search_control_completion(
        manifest,
        &input.server_id,
        server_tool_state.as_ref(),
        &input.payload,
    )?;
    let request_web_search_execution_mode =
        resolve_request_web_search_execution_mode(manifest, &input.payload);
    if request_web_search_execution_mode.is_metadata_center_local_search()
        && server_tool_state.is_none()
    {
        return Err(V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
            "web_search execution state is unavailable".to_string(),
        ));
    }
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
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
    let invocation = crate::operation_runner::RequestInvocationContext::new(
        request_execution_control.request_context().clone(),
        format!("{}:relay-entry", input.request_id),
        format!("{}:entry", input.request_id),
        entry_origin.request_origin_kind(),
    );
    let req02 = build_v3_hub_req_inbound_02_from_request_invocation(req01, &invocation)
        .map_err(V3ResponsesRelayRuntimeError::ClientInboundCanonical)?;
    trace.push("V3HubReqInbound02Normalized");
    let request_hook_profile = responses_relay_request_hook_profile(
        manifest,
        &input.server_id,
        request_web_search_execution_mode,
    );
    let request_outcome = {
        compile_v3_hub_relay_request_hooks().run_from_normalized(req02, &request_hook_profile)?
    };
    trace.push("V3HubReqChatProcess04Governed");
    let request_web_search_state = request_outcome.web_search_state().cloned();
    store_v3_responses_relay_web_search_state(
        server_tool_state.as_ref(),
        request_web_search_state.as_ref(),
    )?;
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
    let provider_semantic_body = std::sync::Arc::clone(request_outcome.payload_arc());
    // Virtual Router consumes the governed ChatProcess semantic object. Using the
    // pre-hook Responses body here would classify the wire shape instead of the
    // normalized request and can miss semantic routing facts such as reasoning.
    let route_facts_body = std::sync::Arc::clone(request_outcome.payload_arc());
    let request_tool_thinking_enabled = request_outcome.tool_thinking_enabled();
    let request_tool_thinking_turn_context = request_outcome.tool_thinking_turn_context().clone();
    let req04 = request_outcome.into_governed();
    govern_v3_operation_runner_current_request_fields(req04.governed_payload(), &invocation, &[])
        .map_err(V3ResponsesRelayRuntimeError::ClientInboundCanonical)?;
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let mut failed_candidates = initial_request_local_excluded_candidates;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut pending_provider_action_recovery = None;
    let mut _provider_action_permit: Option<V3ProviderActionPermit> = None;
    let mut provider_action_permit_target: Option<routecodex_v3_target::V3TargetCandidate> = None;
    let mut initial_selected_target = initial_selected_target;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut last_external_http = None;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let attempt_budget = request_execution_control.attempt_budget();
    let mut provider_send_attempts = attempt_budget.transport_attempts();
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let allowed_execution_modes = handle_error_before_resp03!(
        allowed_execution_modes_for_relay_server(manifest, &input.server_id,)
    );
    let shared_retry_policy = retry_policy.as_shared_policy();
    let provider_failure_health = provider_health.clone();
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        captured_target_09: initial_expanded.as_ref(),
        failure_session_scope: input.failure_session_scope.clone(),
        provider_health: &provider_failure_health,
        retry_policy: shared_retry_policy,
        deterministic_sample,
    };
    let mut relay_attempt_index = 0_u64;
    loop {
        let attempt_id = format!("{}:relay-attempt:{relay_attempt_index}", input.request_id);
        relay_attempt_index = relay_attempt_index.saturating_add(1);
        let (selected, mut selected_admission): (
            routecodex_v3_target::V3Target10ConcreteProviderSelected,
            Option<V3RuntimeProviderAdmission>,
        ) = {
            let preferred_selected = retry_selected
                .take()
                .or_else(|| initial_selected_target.take());
            let target_resolution_input = V3RelayProviderTargetResolutionInput {
                manifest,
                server_id: &input.server_id,
                failure_session_scope: &input.failure_session_scope,
                entry_kind: "responses",
                endpoint_path: "/v1/responses",
                body: &route_facts_body,
                request_local_excluded_candidates: &failed_candidates,
                provider_health: &provider_health,
                now_ms: v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                deterministic_sample,
            };
            let target_resolution = resolve_v3_relay_target_outcome_with_admission_rescue(
                target_resolution_input,
                allow_exhaustion_rescue_probe,
                preferred_selected,
            )
            .await;
            match target_resolution {
                V3RelayProviderAdmittedTargetResolution::Selected(selected) => {
                    (selected.selected, Some(selected.admission))
                }
                V3RelayProviderAdmittedTargetResolution::Failed(source) => {
                    return Err(V3ResponsesRelayRuntimeError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )));
                }
                V3RelayProviderAdmittedTargetResolution::Exhausted {
                    attempted_candidates,
                } => {
                    let failure = V3ResponsesRelayProviderFailure {
                        status: 502,
                        // Target exhaustion is local: no upstream HTTP response.
                        provider_status: None,
                        policy_error_type: "selected_target_exhausted".to_string(),
                        policy_error_message: format!(
                            "selected target exhausted after {attempted_candidates:?}"
                        ),
                        provider_id: "none".to_string(),
                        source_stage: "V3Target10ConcreteProviderSelected",
                        observability: None,
                        terminal_projection: None,
                        terminal_disposition: None,
                        matched_policy: None,
                    };
                    return Ok(provider_failure_output(
                        terminalize_v3_responses_relay_provider_failure(
                            failure,
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
        let protocol_decision =
            handle_error_before_resp03!(
                crate::nodes::build_v3_execution_11_protocol_decision_from_v3_target_10(
                    selected.clone(),
                    "responses",
                    &allowed_execution_modes,
                )
                .map_err(|source| V3ResponsesRelayRuntimeError::ExecutionControl(
                    format!("{}: {}", source.code, source.message)
                ))
            );
        if matches!(
            protocol_decision.mode,
            crate::nodes::V3Execution11ProtocolDecisionMode::SameProtocolDirect
        ) {
            let captured_expanded = match initial_expanded.as_ref() {
                Some(expanded) => expanded.clone(),
                None => handle_error_before_resp03!(expand_v3_relay_target_plan_for_selected(
                    manifest,
                    &selected,
                    deterministic_sample,
                )
                .map_err(V3ResponsesRelayRuntimeError::ExecutionControl)),
            };
            let protocol_candidate_keys = handle_error_before_resp03!(
                crate::kernel::protocol_candidate_keys_for_decision_mode(
                    &captured_expanded,
                    "responses",
                    &allowed_execution_modes,
                    protocol_decision.mode,
                )
                .map_err(|source| V3ResponsesRelayRuntimeError::ExecutionControl(
                    format!("{}: {}", source.code, source.message)
                ))
            );
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
                stream_observation: None,
                finalized_response: None,
                provider_snapshots: None,
                protocol_direct_handoff: Some(V3ResponsesProtocolDirectHandoff {
                    request_payload: req05.governed_payload().clone(),
                    plan: V3ResponsesProtocolExecutionPlan {
                        decision: protocol_decision,
                        node_trace: handoff_trace.clone(),
                        expanded: captured_expanded,
                        protocol_candidate_keys,
                        request_local_excluded_candidates: failed_candidates.clone(),
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
                    request_entry_origin: crate::kernel::V3DirectEntryOrigin::DirectRelayHandoff,
                }),
                request_finalizer: None,
            });
        }
        let selected_target_provider_id = selected.candidate.provider_id.clone();
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
        let mut selected_observability =
            build_v3_relay_observability_from_selected(&selected, client_response_transport_intent);
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
                    Box::pin(handle_v3_responses_relay_provider_failure(
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
                    ))
                    .await
                );
                if let Some(failure) = terminal_failure {
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }};
        }
        let req07 = match build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
            req06,
            req05.governed_payload(),
            request_execution_control.request_context(),
            V3HubExecutionMode::Relay,
            &attempt_id,
            provider_wire_protocol,
        ) {
            Ok(req07) => req07,
            Err(error) => {
                let mut error = classify_v3_provider_compat_error(
                    "request_protocol",
                    &V3ProviderCompatProfileId::from_config(
                        selected.candidate.compatibility_profile.as_deref(),
                    ),
                    error,
                );
                error.stage = "V3HubReqOutbound07ProviderSemantic";
                handle_provider_request_failure!(V3ResponsesRelayRuntimeError::ProviderCompat(
                    error
                ));
            }
        };
        let attempt_context = req07.attempt_context().clone();
        let target =
            handle_error_before_resp03!(provider_target(manifest, req07.selected_target()));
        let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {
            Ok(projected) => record_projected_drops(&projection_drop_context, projected),
            Err(error) => {
                handle_provider_request_failure!(V3ResponsesRelayRuntimeError::ProviderCompat(
                    error
                ));
            }
        };
        trace.push("V3HubReqTarget06Resolved");
        trace.push("V3HubReqOutbound07ProviderSemantic");
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = _req09.into_provider_semantic_payload();
        let wire = match build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        ) {
            Ok(wire) => wire,
            Err(error) => {
                handle_provider_request_failure!(V3ResponsesRelayRuntimeError::Provider(error));
            }
        };
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request =
            match build_v3_provider_transport_request_for_protocol(provider_wire_protocol, wire) {
                Ok(transport_request) => transport_request,
                Err(error) => {
                    handle_provider_request_failure!(V3ResponsesRelayRuntimeError::Target(error));
                }
            };
        if let Err(error) = validate_v3_responses_relay_provider_request_transport_intent(
            provider_request_transport_intent,
            transport_request.stream_intent(),
        ) {
            handle_provider_request_failure!(error);
        }
        trace.push("V3ProviderReqOutbound09TransportRequest");
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
                            failed_candidates
                                .insert(v3_relay_provider_candidate_key(&selected.candidate));
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
                    pending_provider_action_recovery = Some(handle_error_before_resp03!(ticket
                        .recovery_witness()
                        .map_err(V3ResponsesRelayRuntimeError::ProviderHealth)));
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket) => {
                    pending_provider_action_recovery = Some(handle_error_before_resp03!(ticket
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
        provider_send_attempts = handle_error_before_resp03!(attempt_budget
            .admit_transport_attempt()
            .map_err(|error| V3ResponsesRelayRuntimeError::ExecutionControl(error.to_string())));
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
                failed_candidates.insert(v3_relay_provider_candidate_key(&selected.candidate));
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
                let failure = if let Some(reason) = &response.body_read_failure {
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
                drop(_provider_action_permit.take());
                let terminal_failure = handle_error_before_resp03!(
                    Box::pin(handle_v3_responses_relay_provider_failure(
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
                    ))
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
                let failure = provider_runtime_failure(
                    error,
                    &selected_target_provider_id,
                    Some(selected_observability.clone()),
                );
                drop(_provider_action_permit.take());
                let terminal_failure = handle_error_before_resp03!(
                    Box::pin(handle_v3_responses_relay_provider_failure(
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
                    ))
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
        let provider_id = provider_raw.provider_id().to_string();
        include!("responses_relay_runtime_inner_response_interpretation.rs")
    }
}
