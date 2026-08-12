use super::*;
use futures_util::StreamExt;
use serde_json::{json, Value};

pub(crate) async fn execute_v3_responses_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    stopless_control: Option<V3ResponsesRelayStoplessControlExecution<'_>>,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3ResponsesRelayRetryPolicy,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    initial_request_local_excluded_candidates: BTreeSet<String>,
    initial_observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let observability_accumulator =
        initial_observability_accumulator.unwrap_or_else(V3RuntimeObservabilityAccumulator::start);
    let runtime_timing = observability_accumulator.timing();
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3ResponsesRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let transition_request_id = input.request_id.clone();
    let transition_updated_at = local
        .as_ref()
        .map(|execution| execution.now_epoch_ms)
        .unwrap_or(v3_responses_relay_now_epoch_ms()?);
    let stopless_control_has_client_session_scope = stopless_control
        .as_ref()
        .map(|execution| execution.scope.has_client_session_scope())
        .unwrap_or(false);
    let mut trace = Vec::with_capacity(17);
    let client_response_transport_intent =
        v3_responses_relay_transport_intent_from_stream_field(&input.payload);
    let provider_request_transport_intent = client_response_transport_intent;
    let local_tool_output_ids = find_responses_tool_output_ids(&input.payload)?;
    let protocol_switch_allowed =
        responses_relay_protocol_switch_allowed(&input.payload, &local_tool_output_ids);
    apply_v3_responses_relay_web_search_control_completion(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
        &input.payload,
    )?;
    let request_web_search_execution_mode =
        resolve_request_web_search_execution_mode(manifest, &input.payload);
    let request_web_search_backend_binding =
        resolve_request_web_search_backend_binding(manifest, &input.payload);
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        client_response_transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let req02 = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(req01)
        .map_err(V3ResponsesRelayRuntimeError::InboundCanonical)?;
    trace.push("V3HubReqInbound02Normalized");
    let route_facts_body = req02.payload().clone();
    let base_hub_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        &input.server_id,
        server_routing_group(manifest, &input.server_id)?,
        &input.request_id,
    );
    let request_stopless_control_state = load_v3_responses_relay_stopless_control_state(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
    )?;
    let request_hook_profile = responses_relay_request_hook_profile(
        manifest,
        &input.server_id,
        request_stopless_control_state.as_ref(),
        stopless_control_has_client_session_scope,
        &transition_request_id,
        transition_updated_at,
        request_web_search_execution_mode,
    );
    let request_outcome = {
        let local_store_guard = if let (Some(local), Some(_)) =
            (local.as_ref(), local_tool_output_ids.restore_ids.first())
        {
            Some(local.state.lock_store()?)
        } else {
            None
        };
        let lookup = if let (Some(local), Some(context_id)) =
            (local.as_ref(), local_tool_output_ids.restore_ids.first())
        {
            if local.scope.routing_group != server_routing_group(manifest, &input.server_id)? {
                return Err(V3ResponsesRelayRuntimeError::LocalContinuationScopeMismatch);
            }
            let store = local_store_guard
                .as_deref()
                .ok_or(V3ResponsesRelayRuntimeError::LocalContinuationStatePoisoned)?;
            V3HubContinuationLookup::new(Some(context_id), local.scope.hub_scope(&input.server_id))
                .with_local_context_from_req04_store(
                    context_id,
                    local.scope.hub_scope(&input.server_id),
                    store,
                    local.scope.local_key(),
                    local.now_epoch_ms,
                    &local_tool_output_ids.restore_ids[1..],
                )?
        } else {
            V3HubContinuationLookup::new(None, base_hub_scope)
        };
        compile_v3_hub_relay_request_hooks().run_from_normalized(
            req02,
            &lookup,
            &request_hook_profile,
        )?
    };
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let stopless_state = request_outcome
        .stopless_state()
        .cloned()
        .map(|state| state.with_max_stop_budget_floor(4));
    apply_v3_responses_relay_stopless_control_request_transition(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
        request_stopless_control_state.is_some(),
        stopless_state.as_ref(),
    )?;
    let request_web_search_state = request_outcome.web_search_state().cloned();
    apply_v3_responses_relay_web_search_control_request_transition(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
        request_web_search_state.as_ref(),
    )?;
    macro_rules! handle_error_before_resp03 {
        ($expr:expr) => {
            match $expr {
                Ok(value) => value,
                Err(error) => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(error.into());
                }
            }
        };
    }
    let provider_semantic_body = std::sync::Arc::clone(request_outcome.payload_arc());
    let anthropic_response_projection_context =
        V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&provider_semantic_body)
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderWireEncoding(error.to_string())
            })?;
    let req04 = request_outcome.into_governed();
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let mut failed_candidates = initial_request_local_excluded_candidates;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut pending_provider_action_recovery = None;
    let mut initial_selected_target = initial_selected_target;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut provider_send_attempts = 0usize;
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
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
    let allowed_modes = allowed_execution_modes_for_relay_server(manifest, &input.server_id)?;
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else if let Some(selected) = initial_selected_target.take() {
            selected
        } else {
            match resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
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
            }) {
                V3RelayProviderTargetResolution::Selected(selected) => selected,
                V3RelayProviderTargetResolution::Failed(source)
                    if source.source_kind == V3ErrorSourceKind::ModelNotFound =>
                {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::ModelNotFound(
                        source.message.clone(),
                    ));
                }
                V3RelayProviderTargetResolution::Failed(source) => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )));
                }
                V3RelayProviderTargetResolution::Exhausted {
                    attempted_candidates,
                } => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::Target(format!(
                        "selected target exhausted after {attempted_candidates:?}"
                    )));
                }
            }
        };
        if protocol_switch_allowed {
            let decision = build_v3_execution_11_protocol_decision_from_v3_target_10(
                selected.clone(),
                "responses",
                &allowed_modes,
            )
            .map_err(|source| V3ResponsesRelayRuntimeError::Target(source.message.clone()))?;
            if decision.mode == V3Execution11ProtocolDecisionMode::SameProtocolDirect {
                trace.push("V3Execution11ProtocolDecision");
                let expanded = match initial_expanded.clone() {
                    Some(expanded) => expanded,
                    None => expand_v3_relay_target_plan_for_selected(
                        manifest,
                        &selected,
                        deterministic_sample,
                    )
                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                };
                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                    manifest,
                    &input.server_id,
                    stopless_control.as_ref(),
                    stopless_state.as_ref(),
                )?;
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 0,
                    client_body: V3ResponsesRelayClientBody::Json(Value::Null),
                    node_trace: Vec::new(),
                    error_chain: None,
                    observability: None,
                    stream_observation: None,
                    finalized_response: None,
                    provider_snapshots: None,
                    protocol_direct_handoff: Some(V3ResponsesProtocolDirectHandoff {
                        request_payload:
                            build_v3_openai_responses_standard_request_from_chat_canonical(
                                &provider_semantic_body,
                            )
                            .map_err(V3ResponsesRelayRuntimeError::ProviderWireEncoding)?,
                        plan: V3ResponsesProtocolExecutionPlan {
                            decision,
                            node_trace: vec![
                                "V3Req04StandardizedResponses",
                                "V3Router05RequestClassified",
                                "V3Router06RoutePoolResolved",
                                "V3Router07OpaqueTargetHitOnce",
                                "V3Target08KindClassified",
                                "V3Target09CandidateSetExpanded",
                                "V3Target10ConcreteProviderSelected",
                                "V3Execution11ProtocolDecision",
                            ],
                            expanded,
                            protocol_candidate_keys: BTreeSet::new(),
                            request_local_excluded_candidates: failed_candidates.clone(),
                        },
                        node_trace: trace,
                        provider_failure_events: provider_failure_events.clone(),
                        observability_accumulator: observability_accumulator
                            .clone()
                            .with_additional_attempts(provider_send_attempts),
                    }),
                });
            }
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
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
        let target =
            handle_error_before_resp03!(provider_target(manifest, req07.selected_target()));
        let mut selected_observability =
            build_v3_relay_observability_from_selected(&selected, client_response_transport_intent);
        selected_observability.attempts = Some(
            observability_accumulator
                .attempts()
                .saturating_add(provider_send_attempts)
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
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }};
        }
        let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {
            Ok(req_compat) => req_compat,
            Err(error) => {
                handle_provider_request_failure!(V3ResponsesRelayRuntimeError::ProviderCompat(
                    error
                ));
            }
        };
        provider_send_attempts = provider_send_attempts.saturating_add(1);
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
        let mut _provider_action_permit: Option<V3ProviderActionPermit> = None;
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match handle_error_before_resp03!(provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
                .map_err(V3ResponsesRelayRuntimeError::ProviderHealth))
            {
                V3ProviderActionRecoveryTransition::Admitted(mut admission) => {
                    _provider_action_permit = admission.take_permit();
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
            }
        }
        handle_error_before_resp03!(runtime_timing
            .start_external()
            .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
        let transport_result = match tokio::time::timeout(
            V3_RELAY_TRANSPORT_RESPONSE_TIMEOUT,
            transport.send(transport_request),
        )
        .await
        {
            Err(_) => Err(V3ProviderError::Transport {
                request_id: input.request_id.clone(),
                provider_id: selected_target_provider_id.clone(),
                reason: "provider transport did not return response headers within timeout"
                    .to_string(),
            }),
            Ok(result) => result,
        };
        let provider_raw = match transport_result {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                handle_error_before_resp03!(runtime_timing
                    .finish_external()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                let failure = provider_http_failure(
                    response.status,
                    &response.body,
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
                            provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                            selected_observability: &selected_observability,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
            Err(error) => {
                handle_error_before_resp03!(runtime_timing
                    .finish_external()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                let failure = provider_runtime_failure(
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
                            provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                            selected_observability: &selected_observability,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
        };
        if provider_raw.body_kind()
            == routecodex_v3_provider_responses::V3ProviderResponseBodyKind::Json
        {
            handle_error_before_resp03!(runtime_timing
                .finish_external()
                .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
        }
        let provider_status = provider_raw.status();
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
                                reason: format!("provider JSON response decode failed: {error}"),
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
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                };
                if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                    if let Some(semantic_error) =
                        responses_relay_diagnostics::anthropic_cyber_refusal_error_from_payload(
                            &provider_value,
                        )
                    {
                        let failure = provider_semantic_failure(
                            429,
                            semantic_error,
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
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let hook_provider_value =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        handle_error_before_resp03!(
                            project_v3_anthropic_message_as_responses_response_with_context(
                                &provider_value,
                                &anthropic_response_projection_context,
                            )
                            .map_err(|error| {
                                V3ResponsesRelayRuntimeError::InboundCanonical(error.to_string())
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
                if provider_wire_protocol == V3HubProviderWireProtocol::OpenAiChat {
                    if let Some(semantic_error) =
                        responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    ) {
                        let failure = provider_semantic_failure(
                            provider_status,
                            semantic_error,
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
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let request_web_search_state = match request_web_search_state.clone() {
                    Some(state) => Some(state),
                    None => match stopless_control.as_ref() {
                        Some(execution) => execution
                            .control
                            .web_search_load_for_scope(&execution.scope)?,
                        None => None,
                    },
                };
                let (
                    action,
                    mut finalized_provider_value,
                    response_stopless_state,
                    response_web_search_state,
                ) = match run_json_response_hooks(
                    V3ResponsesRelayJsonResponseHookInput {
                        provider_value: &hook_provider_value,
                        provider_semantic_body: &provider_semantic_body,
                        manifest,
                        server_id: &input.server_id,
                        provider_id: Some(&selected_target_provider_id),
                        provider_protocol: hook_provider_protocol,
                        provider_response_transport_intent: V3HubTransportIntent::Json,
                        compatibility_profile: selected.candidate.compatibility_profile.as_deref(),
                        web_search_execution_mode: selected.candidate.web_search_execution_mode,
                        web_search_center_state: request_web_search_state,
                        stopless_state: stopless_state.as_ref(),
                        stopless_control_has_client_session_scope,
                        transition_request_id: &transition_request_id,
                        transition_updated_at,
                        retain_response_cipher: is_v3_retain_response_cipher(
                            selected.route.target_plan.len(),
                            &selected.candidate.model_id,
                        ),
                    },
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
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                    Err(error) => handle_error_before_resp03!(Err(error)),
                };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    &input.server_id,
                    stopless_control.as_ref(),
                    response_stopless_state.clone(),
                )?;
                if let Some(web_search_state) = response_web_search_state {
                    let captured = if web_search_state.phase()
                        == V3WebSearchCenterPhase::SearchResultCaptured
                    {
                        web_search_state
                    } else {
                        execute_local_web_search_hop(
                            manifest,
                            &input.server_id,
                            &input.failure_session_scope,
                            &provider_failure_health,
                            request_web_search_backend_binding.as_deref(),
                            &web_search_state,
                            transport,
                            &input.request_id,
                        )
                        .await?
                    };
                    project_web_search_result_into_finalized(
                        &mut finalized_provider_value,
                        &captured,
                    )?;
                    if let Some(execution) = stopless_control.as_ref() {
                        if execution.commit_effects && execution.scope.has_client_session_scope() {
                            execution
                                .control
                                .web_search_store_for_scope(
                                    &execution.scope,
                                    captured,
                                    V3ServerToolCenterWriteOrigin {
                                        module: "responses_relay_runtime",
                                        symbol: "commit_or_release_responses_local_continuation",
                                        stage: "resp03_commit_effects",
                                    },
                                    Some("resp03 commit effects persist captured web_search state"),
                                    None,
                                )?;
                        }
                    }
                }
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    provider_semantic_body.as_ref(),
                    &finalized_provider_value,
                    action,
                )?;
                handle_error_before_resp03!(provider_health
                    .record_provider_success_in_failure_scope(
                        &failure_context.failure_session_scope,
                        &selected_target_provider_id,
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
                let response_status = read_v3_runtime_response_status(&finalized_provider_value);
                observability.finish_reason =
                    read_v3_runtime_finish_reason(&finalized_provider_value)
                        .or_else(|| read_v3_runtime_finish_reason(&provider_value))
                        .or_else(|| {
                            infer_v3_runtime_finish_reason(action, response_status.as_deref())
                        });
                observability.response_status = response_status;
                observability.usage = extract_v3_runtime_usage_summary(&finalized_provider_value);
                observability.stopless_activation = response_stopless_state
                    .as_ref()
                    .and_then(V3StoplessCenterState::last_provider_stopless_call_id)
                    .is_some();
                observability.timing = Some(handle_error_before_resp03!(runtime_timing
                    .finish_runtime()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming)));
                let finalized_response = finalized_provider_value.clone();
                let client_body = project_v3_responses_relay_client_body(
                    client_response_transport_intent,
                    finalized_provider_value,
                );
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body,
                    node_trace: trace,
                    error_chain: None,
                    observability: Some(observability),
                    stream_observation: None,
                    finalized_response: Some(finalized_response),
                    provider_snapshots: None,
                    protocol_direct_handoff: None,
                });
            }
            V3ProviderResponseBody::Sse(stream) => {
                let stream_observation = V3RuntimeStreamObservation::default();
                let provider_value_result =
                    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
                        provider_wire_protocol,
                        crate::hub_v1::relay_runtime_core::guard_v3_provider_sse_idle(
                            &input.request_id,
                            &selected_target_provider_id,
                            stream,
                            crate::hub_v1::relay_runtime_core::V3_RELAY_SSE_STREAM_IDLE_TIMEOUT,
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
                        let failure = provider_response_stream_relay_failure(
                            error,
                            &input.request_id,
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
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
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
                if provider_wire_protocol == V3HubProviderWireProtocol::OpenAiChat {
                    if let Some(semantic_error) =
                        responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    ) {
                        let failure = provider_semantic_failure(
                            provider_status,
                            semantic_error,
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
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let (
                    action,
                    mut finalized_provider_value,
                    response_stopless_state,
                    response_web_search_state,
                ) = match run_json_response_hooks(
                    V3ResponsesRelayJsonResponseHookInput {
                        provider_value: &provider_value,
                        provider_semantic_body: &provider_semantic_body,
                        manifest,
                        server_id: &input.server_id,
                        provider_id: Some(&selected_target_provider_id),
                        provider_protocol: hook_provider_protocol,
                        provider_response_transport_intent: V3HubTransportIntent::Sse,
                        compatibility_profile: selected.candidate.compatibility_profile.as_deref(),
                        web_search_execution_mode: selected.candidate.web_search_execution_mode,
                        // web_search 与 stopless 解耦：当前轮拦截直接使用 Req04
                        // 激活的 LocalToolSurfaceActive state（request_web_search_state），
                        // 不依赖 stopless_control 桶。
                        web_search_center_state: request_web_search_state.clone().or_else(|| {
                            stopless_control
                                .as_ref()
                                .and_then(|execution| {
                                    execution
                                        .control
                                        .web_search_load_for_scope(&execution.scope)
                                        .ok()
                                })
                                .flatten()
                        }),
                        stopless_state: stopless_state.as_ref(),
                        stopless_control_has_client_session_scope,
                        transition_request_id: &transition_request_id,
                        transition_updated_at,
                        retain_response_cipher: is_v3_retain_response_cipher(
                            selected.route.target_plan.len(),
                            &selected.candidate.model_id,
                        ),
                    },
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
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                    Err(error) => handle_error_before_resp03!(Err(error)),
                };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    &input.server_id,
                    stopless_control.as_ref(),
                    response_stopless_state.clone(),
                )?;
                if let Some(web_search_state) = response_web_search_state {
                    // MiniMax hosted search：结果已随同一响应返回
                    // （SearchResultCaptured）→ 跳过本地搜索 hop；否则走
                    // backend direct pin 的搜索 hop。
                    let captured = if web_search_state.phase()
                        == V3WebSearchCenterPhase::SearchResultCaptured
                    {
                        web_search_state
                    } else {
                        execute_local_web_search_hop(
                            manifest,
                            &input.server_id,
                            &input.failure_session_scope,
                            &provider_failure_health,
                            request_web_search_backend_binding.as_deref(),
                            &web_search_state,
                            transport,
                            &input.request_id,
                        )
                        .await?
                    };
                    project_web_search_result_into_finalized(
                        &mut finalized_provider_value,
                        &captured,
                    )?;
                    if let Some(execution) = stopless_control.as_ref() {
                        if execution.commit_effects && execution.scope.has_client_session_scope() {
                            execution
                                .control
                                .web_search_store_for_scope(
                                    &execution.scope,
                                    captured,
                                    V3ServerToolCenterWriteOrigin {
                                        module: "responses_relay_runtime",
                                        symbol: "commit_or_release_responses_local_continuation",
                                        stage: "resp03_commit_effects",
                                    },
                                    Some("resp03 commit effects persist captured web_search state"),
                                    None,
                                )?;
                        }
                    }
                }
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    provider_semantic_body.as_ref(),
                    &finalized_provider_value,
                    action,
                )?;
                handle_error_before_resp03!(provider_health
                    .record_provider_success_in_failure_scope(
                        &failure_context.failure_session_scope,
                        &selected_target_provider_id,
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
                let response_status = read_v3_runtime_response_status(&finalized_provider_value);
                observability.finish_reason =
                    read_v3_runtime_finish_reason(&finalized_provider_value)
                        .or_else(|| read_v3_runtime_finish_reason(&provider_value))
                        .or_else(|| {
                            stream_observation
                                .snapshot()
                                .ok()
                                .and_then(|snapshot| snapshot.finish_reason)
                        })
                        .or_else(|| {
                            infer_v3_runtime_finish_reason(action, response_status.as_deref())
                        });
                if let Some(finish_reason) = observability.finish_reason.as_deref() {
                    stream_observation
                        .record_finish_reason(finish_reason)
                        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
                }
                observability.response_status = response_status;
                observability.usage = extract_v3_runtime_usage_summary(&finalized_provider_value)
                    .or_else(|| extract_v3_runtime_usage_summary(&provider_value))
                    .or_else(|| {
                        stream_observation
                            .snapshot()
                            .ok()
                            .and_then(|snapshot| snapshot.usage)
                    });
                observability.stopless_activation = response_stopless_state
                    .as_ref()
                    .and_then(V3StoplessCenterState::last_provider_stopless_call_id)
                    .is_some();
                let timing = handle_error_before_resp03!(runtime_timing
                    .finish_runtime()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                observability.timing = Some(timing);
                stream_observation
                    .record_timing(timing)
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming)?;
                let client_response_is_sse =
                    client_response_transport_intent == V3HubTransportIntent::Sse;
                let finalized_response = finalized_provider_value.clone();
                let client_body = project_v3_responses_relay_client_body(
                    client_response_transport_intent,
                    finalized_provider_value,
                );
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body,
                    node_trace: trace,
                    error_chain: None,
                    observability: Some(observability),
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
}

#[derive(Debug, Default)]
pub(crate) struct V3ResponsesRelayToolOutputIds {
    pub(crate) restore_ids: Vec<String>,
    pub(crate) consumed_ids: Vec<String>,
}

pub(crate) fn find_responses_tool_output_ids(
    payload: &Value,
) -> Result<V3ResponsesRelayToolOutputIds, V3ResponsesRelayRuntimeError> {
    let paired_call_ids = payload_input_paired_call_ids(payload);
    let previous_response_id = payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let mut ids = V3ResponsesRelayToolOutputIds::default();
    if let Some(previous_response_id) = previous_response_id {
        ids.consumed_ids.push(previous_response_id.to_owned());
    }
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
            .filter(|value| !value.is_empty())
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Responses tool output requires call_id".to_string(),
            })?;
        if !ids.consumed_ids.iter().any(|existing| existing == id) {
            ids.consumed_ids.push(id.to_owned());
        }
        if is_v3_stopless_internal_call_id(id) {
            if let Some(response_id) = previous_response_id {
                if !ids
                    .consumed_ids
                    .iter()
                    .any(|existing| existing == response_id)
                {
                    ids.consumed_ids.push(response_id.to_owned());
                }
                if !ids
                    .restore_ids
                    .iter()
                    .any(|existing| existing == response_id)
                {
                    ids.restore_ids.push(response_id.to_owned());
                }
                continue;
            }
        }
        if paired_call_ids.iter().any(|paired| paired == id) {
            continue;
        }
        if !ids.restore_ids.iter().any(|existing| existing == id) {
            ids.restore_ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

