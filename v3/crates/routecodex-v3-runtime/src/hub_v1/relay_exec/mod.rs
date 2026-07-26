use super::*;

pub(super) async fn execute_v3_responses_relay_runtime_inner_stages<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    stopless_control: Option<V3ResponsesRelayStoplessControlExecution<'_>>,
    provider_health: V3ProviderHealthStore,
    retry_policy: V3ResponsesRelayRetryPolicy,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
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
        .unwrap_or(true);
    let mut trace = Vec::with_capacity(17);
    let client_response_transport_intent =
        v3_responses_relay_transport_intent_from_stream_field(&input.payload);
    let provider_request_transport_intent = client_response_transport_intent;
    let local_tool_output_ids = find_responses_tool_output_ids(&input.payload)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        client_response_transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let req02 =
        build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(req01)
            .map_err(V3ResponsesRelayRuntimeError::InboundCanonical)?;
    trace.push("V3HubReqInbound02Normalized");
    let base_hub_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        &input.server_id,
        server_routing_group(manifest, &input.server_id)?,
        &input.request_id,
    );
    let request_stopless_control_state =
        load_v3_responses_relay_stopless_control_state(manifest, stopless_control.as_ref())?;
    let request_hook_profile = responses_relay_request_hook_profile(
        manifest,
        request_stopless_control_state.as_ref(),
        stopless_control_has_client_session_scope,
        &transition_request_id,
        transition_updated_at,
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
    let stopless_state = request_outcome.stopless_state().cloned();
    apply_v3_responses_relay_stopless_control_request_transition(
        manifest,
        stopless_control.as_ref(),
        request_stopless_control_state.is_some(),
        stopless_state.as_ref(),
    )?;
    macro_rules! try_before_resp03 {
        ($expr:expr) => {
            match $expr {
                Ok(value) => value,
                Err(error) => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(error.into());
                }
            }
        };
    }
    let provider_semantic_body = request_outcome.payload().clone();
    let route_facts_body = request_outcome
        .responses_original_input_surface_payload()
        .unwrap_or_else(|| provider_semantic_body.clone());
    let local_continuation_request_body = route_facts_body.clone();
    let req04 = request_outcome.into_governed();
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let provider_health = V3ProviderFailureRuntimeHealth::from(provider_health);
    let mut failed_candidates = BTreeSet::new();
    let mut pending_provider_failure: Option<V3ResponsesRelayProviderFailure> = None;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut initial_selected_target = initial_selected_target;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut provider_send_attempts = 0usize;
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let shared_retry_policy = retry_policy.as_shared_policy();
    let provider_failure_health = provider_health.clone();
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        server_id: &input.server_id,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        route_facts_body: &route_facts_body,
        provider_health: &provider_failure_health,
        retry_policy: shared_retry_policy,
        deterministic_sample,
    };
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else if let Some(selected) = initial_selected_target.take() {
            selected
        } else {
            match resolve_v3_relay_target(V3RelayProviderTargetResolutionInput {
                manifest,
                server_id: &input.server_id,
                entry_kind: "responses",
                endpoint_path: "/v1/responses",
                body: &route_facts_body,
                request_local_excluded_candidates: &failed_candidates,
                provider_health: &provider_health,
                now_ms: v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                deterministic_sample,
            }) {
                Ok(selected) => selected,
                Err(error) => {
                    if let Some(failure) = pending_provider_failure.take() {
                        clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                            manifest,
                            stopless_control.as_ref(),
                            stopless_state.as_ref(),
                        )?;
                        return Ok(provider_failure_output(failure, trace, 0));
                    }
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::Target(error));
                }
            }
        };
        provider_send_attempts = provider_send_attempts.saturating_add(1);
        let mut selected_observability =
            build_v3_relay_observability_from_selected(&selected, client_response_transport_intent);
        selected_observability.attempts = Some(provider_send_attempts);
        selected_observability.provider_failure_events = provider_failure_events.clone();
        let selected_target_provider_id = selected.candidate.provider_id.clone();
        let selected_target_auth_alias = selected.candidate.auth_alias.clone();
        let selected_target_model_id = selected.candidate.model_id.clone();
        let provider_wire_protocol = try_before_resp03!(
            provider_wire_protocol_for_selected_candidate(&selected.candidate)
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = try_before_resp03!(provider_target(manifest, req07.selected_target()));
        let req_compat = try_before_resp03!(
            build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        );
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = _req09.into_provider_semantic_payload();
        let wire = try_before_resp03!(build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        ));
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request = try_before_resp03!(
            build_v3_provider_transport_request_for_protocol(provider_wire_protocol, wire)
        );
        try_before_resp03!(
            validate_v3_responses_relay_provider_request_transport_intent(
                provider_request_transport_intent,
                transport_request.stream_intent(),
            )
        );
        trace.push("V3ProviderReqOutbound09TransportRequest");
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                let failure = provider_http_failure(
                    response.status,
                    &response.body,
                    &selected_target_provider_id,
                    Some(selected_observability),
                );
                let terminal_failure = try_before_resp03!(
                    handle_v3_responses_relay_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3ResponsesRelayProviderRetryState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            retry_selected: &mut retry_selected,
                            pending_provider_failure: &mut pending_provider_failure,
                            provider_failure_events: &mut provider_failure_events,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
            Err(error) => {
                let failure = provider_runtime_failure(
                    error,
                    &selected_target_provider_id,
                    Some(selected_observability),
                );
                let terminal_failure = try_before_resp03!(
                    handle_v3_responses_relay_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3ResponsesRelayProviderRetryState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            retry_selected: &mut retry_selected,
                            pending_provider_failure: &mut pending_provider_failure,
                            provider_failure_events: &mut provider_failure_events,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
        };
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
                            Some(selected_observability),
                        );
                        let terminal_failure = try_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_provider_failure: &mut pending_provider_failure,
                                    provider_failure_events: &mut provider_failure_events,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                };
                let hook_provider_value =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        try_before_resp03!(project_v3_anthropic_message_as_responses_response(
                            &provider_value
                        )
                        .map_err(|error| {
                            V3ResponsesRelayRuntimeError::InboundCanonical(error.to_string())
                        }))
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
                    if let Some(semantic_error) = provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    ) {
                        let failure = provider_semantic_failure(
                            provider_status,
                            semantic_error,
                            &selected_target_provider_id,
                            Some(selected_observability),
                        );
                        let terminal_failure = try_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_provider_failure: &mut pending_provider_failure,
                                    provider_failure_events: &mut provider_failure_events,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let (action, finalized_provider_value, response_stopless_state) =
                    match run_json_response_hooks(
                        V3ResponsesRelayJsonResponseHookInput {
                            provider_value: &hook_provider_value,
                            provider_semantic_body: &provider_semantic_body,
                            manifest,
                            provider_id: Some(&selected_target_provider_id),
                            provider_protocol: hook_provider_protocol,
                            provider_response_transport_intent: V3HubTransportIntent::Json,
                            compatibility_profile: selected
                                .candidate
                                .compatibility_profile
                                .as_deref(),
                            stopless_state: stopless_state.as_ref(),
                            stopless_control_has_client_session_scope,
                            transition_request_id: &transition_request_id,
                            transition_updated_at,
                        },
                        &mut trace,
                    ) {
                        Ok(value) => value,
                        Err(error) if is_v3_responses_provider_response_failure(&error) => {
                            let failure = provider_runtime_failure(
                                provider_response_hook_failure(
                                    error,
                                    &input.request_id,
                                    &selected_target_provider_id,
                                ),
                                &selected_target_provider_id,
                                Some(selected_observability),
                            );
                            let terminal_failure = try_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure,
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_provider_failure: &mut pending_provider_failure,
                                        provider_failure_events: &mut provider_failure_events,
                                        trace: &mut trace,
                                    },
                                )
                                .await
                            );
                            if let Some(failure) = terminal_failure {
                                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                    manifest,
                                    stopless_control.as_ref(),
                                    stopless_state.as_ref(),
                                )?;
                                return Ok(provider_failure_output(failure, trace, 0));
                            }
                            continue;
                        }
                        Err(error) => try_before_resp03!(Err(error)),
                    };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    stopless_control.as_ref(),
                    response_stopless_state,
                )?;
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    &local_continuation_request_body,
                    &finalized_provider_value,
                    action,
                )?;
                try_before_resp03!(provider_health
                    .record_provider_success(
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
                observability.stopless_activation =
                    response_has_stopless_activation(&finalized_provider_value);
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
                });
            }
            V3ProviderResponseBody::Sse(stream) => {
                let stream_observation = V3RuntimeStreamObservation::default();
                let provider_value =
                    match build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
                        provider_wire_protocol,
                        stream,
                        &stream_observation,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(error) => {
                            let failure = provider_runtime_failure(
                                provider_response_stream_failure(
                                    error,
                                    &input.request_id,
                                    &selected_target_provider_id,
                                ),
                                &selected_target_provider_id,
                                Some(selected_observability),
                            );
                            let terminal_failure = try_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure,
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_provider_failure: &mut pending_provider_failure,
                                        provider_failure_events: &mut provider_failure_events,
                                        trace: &mut trace,
                                    },
                                )
                                .await
                            );
                            if let Some(failure) = terminal_failure {
                                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                    manifest,
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
                    if let Some(semantic_error) = provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    ) {
                        let failure = provider_semantic_failure(
                            provider_status,
                            semantic_error,
                            &selected_target_provider_id,
                            Some(selected_observability),
                        );
                        let terminal_failure = try_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_provider_failure: &mut pending_provider_failure,
                                    provider_failure_events: &mut provider_failure_events,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let (action, finalized_provider_value, response_stopless_state) =
                    match run_json_response_hooks(
                        V3ResponsesRelayJsonResponseHookInput {
                            provider_value: &provider_value,
                            provider_semantic_body: &provider_semantic_body,
                            manifest,
                            provider_id: Some(&selected_target_provider_id),
                            provider_protocol: hook_provider_protocol,
                            provider_response_transport_intent: V3HubTransportIntent::Sse,
                            compatibility_profile: selected
                                .candidate
                                .compatibility_profile
                                .as_deref(),
                            stopless_state: stopless_state.as_ref(),
                            stopless_control_has_client_session_scope,
                            transition_request_id: &transition_request_id,
                            transition_updated_at,
                        },
                        &mut trace,
                    ) {
                        Ok(value) => value,
                        Err(error) if is_v3_responses_provider_response_failure(&error) => {
                            let failure = provider_runtime_failure(
                                provider_response_hook_failure(
                                    error,
                                    &input.request_id,
                                    &selected_target_provider_id,
                                ),
                                &selected_target_provider_id,
                                Some(selected_observability),
                            );
                            let terminal_failure = try_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure,
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_provider_failure: &mut pending_provider_failure,
                                        provider_failure_events: &mut provider_failure_events,
                                        trace: &mut trace,
                                    },
                                )
                                .await
                            );
                            if let Some(failure) = terminal_failure {
                                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                    manifest,
                                    stopless_control.as_ref(),
                                    stopless_state.as_ref(),
                                )?;
                                return Ok(provider_failure_output(failure, trace, 0));
                            }
                            continue;
                        }
                        Err(error) => try_before_resp03!(Err(error)),
                    };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    stopless_control.as_ref(),
                    response_stopless_state,
                )?;
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    &local_continuation_request_body,
                    &finalized_provider_value,
                    action,
                )?;
                try_before_resp03!(provider_health
                    .record_provider_success(
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
                observability.stopless_activation =
                    response_has_stopless_activation(&finalized_provider_value);
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
                });
            }
        }
    }
}
