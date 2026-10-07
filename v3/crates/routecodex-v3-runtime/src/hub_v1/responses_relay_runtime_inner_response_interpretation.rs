{
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
                if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                    if let Some(semantic_error) =
                        responses_relay_diagnostics::anthropic_cyber_refusal_error_from_payload(
                            &provider_value,
                        )
                    {
                        let failure = provider_semantic_failure(
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
                }
                if let Some(admission) =
                    classify_v3_provider_terminal_admission(provider_wire_protocol, &provider_value)
                {
                    let failure = provider_terminal_admission_failure(
                        admission,
                        provider_status,
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
                let admission_hook_provider_value =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        handle_error_before_resp03!(
                            project_v3_anthropic_message_as_responses_response_with_context(
                                &provider_value,
                                &V3AnthropicResponsesProjectionContext::default(),
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
                if let Some(semantic_error) =
                    responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    )
                    .or_else(|| {
                        responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
                            Some(manifest),
                            Some(&selected_target_provider_id),
                            &admission_hook_provider_value,
                        )
                    })
                {
                    let global_probe_compatible = semantic_error.provider_global_failure
                        && provider_wire_protocol == V3HubProviderWireProtocol::Responses
                        && manifest
                            .providers
                            .get(&selected_target_provider_id)
                            .and_then(|provider| provider.responses.as_ref())
                            .is_some();
                    if global_probe_compatible {
                        let source = routecodex_v3_error::build_v3_error_01_source_raised_external(
                            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
                            "V3HubRespChatProcess03Governed",
                            semantic_error.code.clone(),
                            semantic_error.code.clone(),
                            routecodex_v3_error::V3ExternalErrorLink {
                                kind: routecodex_v3_error::V3ExternalErrorKind::Provider,
                                status: Some(provider_status),
                                code: Some(semantic_error.code.clone()),
                                provider_id: Some(selected_target_provider_id.clone()),
                                upstream_request_id: None,
                                message: Some(semantic_error.code.clone()),
                            },
                        );
                        let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01_with_provider_global_policy(
                            source,
                            semantic_error.cooldown_ms,
                            semantic_error.code.clone(),
                        );
                        provider_health
                            .record_provider_global_health_for_classified_error(
                                &input.failure_session_scope,
                                &selected_target_provider_id,
                                Some(&selected.candidate.auth_alias),
                                Some(&selected.candidate.model_id),
                                &classified,
                                v3_relay_provider_policy_now_epoch_ms()
                                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                            )
                            .map_err(V3ResponsesRelayRuntimeError::Target)?;
                    }
                    let failure = provider_semantic_failure(
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
                let request_web_search_state = match request_web_search_state.clone() {
                    Some(state) => Some(state),
                    None => match server_tool_state.as_ref() {
                        Some(execution) => execution
                            .control
                            .web_search_load_for_scope(&execution.scope)?,
                        None => None,
                    },
                };
                handle_error_before_resp03!(request_execution_control
                    .request_context()
                    .publish_successful_attempt(attempt_context.clone()));
                let successful_attempt_view =
                    crate::operation_runner::ResponseProjectionView::from_successful_attempt(
                        request_execution_control.request_context(),
                        &attempt_context,
                    )
                    .map_err(V3ResponsesRelayRuntimeError::ProviderWireEncoding)?;
                let anthropic_response_projection_context =
                    V3AnthropicResponsesProjectionContext::from_successful_attempt_with_chat_canonical_business_context(
                        &successful_attempt_view,
                        &provider_semantic_body,
                    )
                    .map_err(|error| {
                        V3ResponsesRelayRuntimeError::ProviderWireEncoding(error.to_string())
                    })?;
                let mut hook_provider_value =
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
                handle_error_before_resp03!(
                    super::responses_openai_chat_conversion::restore_v3_responses_provider_representation_tool_identities_with_successful_attempt(
                        &mut hook_provider_value,
                        &successful_attempt_view,
                        provider_wire_protocol,
                    )
                );
                let (mut finalized_provider_value, response_web_search_state) =
                    match run_json_response_hooks(
                        V3ResponsesRelayJsonResponseHookInput {
                            session_id: input.failure_session_scope.session_id(),
                            request_id: &input.request_id,
                            provider_value: &hook_provider_value,
                            provider_semantic_body: &provider_semantic_body,
                            manifest,
                            server_id: &input.server_id,
                            provider_id: Some(&selected_target_provider_id),
                            expected_model_id: &selected_target_model_id,
                            provider_protocol: hook_provider_protocol,
                            source_provider_protocol: provider_wire_protocol,
                            projection_context: &anthropic_response_projection_context,
                            successful_attempt_view: &successful_attempt_view,
                            provider_response_transport_intent: V3HubTransportIntent::Json,
                            tool_thinking_enabled: request_tool_thinking_enabled,
                            tool_thinking_turn_context: &request_tool_thinking_turn_context,
                            compatibility_profile: selected
                                .candidate
                                .compatibility_profile
                                .as_deref(),
                            web_search_execution_mode: selected.candidate.web_search_execution_mode,
                            web_search_center_state: request_web_search_state,
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
                if let Some(web_search_state) = response_web_search_state {
                    let captured = if web_search_state.phase()
                        == V3WebSearchCenterPhase::SearchResultCaptured
                    {
                        web_search_state
                    } else {
                        let execution = server_tool_state.as_ref().ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
                                "web_search execution scope is unavailable".to_string(),
                            )
                        })?;
                        execute_web_search_through_hooks_sidecar(
                            execution.control.hooks_sidecar_socket(),
                            &input.request_id,
                            &execution.scope,
                            &request_execution_control,
                            &web_search_state,
                        )
                        .await?
                    };
                    project_web_search_result_into_finalized(
                        &mut finalized_provider_value,
                        &captured,
                    )?;
                    if let Some(execution) = server_tool_state.as_ref() {
                        if execution.commit_effects && execution.scope.has_client_session_scope() {
                            execution.control.web_search_store_for_scope(
                                &execution.scope,
                                captured,
                                V3ServerToolCenterWriteOrigin {
                                    module: "responses_relay_runtime",
                                    symbol: "web_search_store_for_scope",
                                    stage: "resp03_commit_effects",
                                },
                                Some("resp03 commit effects persist captured web_search state"),
                                None,
                            )?;
                        }
                    }
                }
                let attempt_success_receipt =
                    crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt();
                let _ = (
                    &attempt_success_receipt,
                    &local_tool_output_ids.consumed_ids,
                );
                handle_error_before_resp03!(provider_health
                    .record_provider_success_in_failure_scope(
                        &attempt_success_receipt,
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
                            infer_v3_runtime_finish_reason_from_provider_event_json(
                                Some("response.completed"),
                                response_status.as_deref(),
                            )
                        });
                observability.response_status = response_status;
                observability.usage = extract_v3_runtime_usage_summary(&finalized_provider_value);
                // Resp03 response-side tool projection.
                observability.timing = Some(handle_error_before_resp03!(runtime_timing
                    .finish_runtime()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming)));
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
                    stream_observation: None,
                    finalized_response: Some(finalized_response),
                    provider_snapshots: None,
                    protocol_direct_handoff: None,
                    request_finalizer: None,
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
                        &V3AnthropicResponsesProjectionContext::default(),
                    )
                    .await;
                handle_error_before_resp03!(runtime_timing
                    .finish_external()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                let provider_value = match provider_value_result {
                    Ok(value) => value,
                    Err(error) => {
                        let failure =
                            handle_error_before_resp03!(provider_response_stream_relay_failure(
                                error,
                                &input.request_id,
                                &selected_target_provider_id,
                                Some(selected_observability.clone()),
                            ));
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
                if let Some(semantic_error) =
                    responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    )
                {
                    let global_probe_compatible = semantic_error.provider_global_failure
                        && provider_wire_protocol == V3HubProviderWireProtocol::Responses
                        && manifest
                            .providers
                            .get(&selected_target_provider_id)
                            .and_then(|provider| provider.responses.as_ref())
                            .is_some();
                    if global_probe_compatible {
                        let source = routecodex_v3_error::build_v3_error_01_source_raised_external(
                            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
                            "V3HubRespChatProcess03Governed",
                            semantic_error.code.clone(),
                            semantic_error.code.clone(),
                            routecodex_v3_error::V3ExternalErrorLink {
                                kind: routecodex_v3_error::V3ExternalErrorKind::Provider,
                                status: Some(provider_status),
                                code: Some(semantic_error.code.clone()),
                                provider_id: Some(selected_target_provider_id.clone()),
                                upstream_request_id: None,
                                message: Some(semantic_error.code.clone()),
                            },
                        );
                        let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01_with_provider_global_policy(
                            source,
                            semantic_error.cooldown_ms,
                            semantic_error.code.clone(),
                        );
                        provider_health
                            .record_provider_global_health_for_classified_error(
                                &input.failure_session_scope,
                                &selected_target_provider_id,
                                Some(&selected.candidate.auth_alias),
                                Some(&selected.candidate.model_id),
                                &classified,
                                v3_relay_provider_policy_now_epoch_ms()
                                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                            )
                            .map_err(V3ResponsesRelayRuntimeError::Target)?;
                    }
                    let failure = provider_semantic_failure(
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
                handle_error_before_resp03!(request_execution_control
                    .request_context()
                    .publish_successful_attempt(attempt_context.clone()));
                let successful_attempt_view =
                    crate::operation_runner::ResponseProjectionView::from_successful_attempt(
                        request_execution_control.request_context(),
                        &attempt_context,
                    )
                    .map_err(V3ResponsesRelayRuntimeError::ProviderWireEncoding)?;
                let anthropic_response_projection_context =
                    V3AnthropicResponsesProjectionContext::from_successful_attempt_with_chat_canonical_business_context(
                        &successful_attempt_view,
                        &provider_semantic_body,
                    )
                    .map_err(|error| {
                        V3ResponsesRelayRuntimeError::ProviderWireEncoding(error.to_string())
                    })?;
                let mut provider_value = provider_value;
                handle_error_before_resp03!(
                    super::responses_openai_chat_conversion::restore_v3_responses_provider_representation_tool_identities_with_successful_attempt(
                        &mut provider_value,
                        &successful_attempt_view,
                        provider_wire_protocol,
                    )
                );
                let (mut finalized_provider_value, response_web_search_state) =
                    match run_json_response_hooks(
                        V3ResponsesRelayJsonResponseHookInput {
                            session_id: input.failure_session_scope.session_id(),
                            request_id: &input.request_id,
                            provider_value: &provider_value,
                            provider_semantic_body: &provider_semantic_body,
                            manifest,
                            server_id: &input.server_id,
                            provider_id: Some(&selected_target_provider_id),
                            expected_model_id: &selected_target_model_id,
                            provider_protocol: hook_provider_protocol,
                            source_provider_protocol: provider_wire_protocol,
                            projection_context: &anthropic_response_projection_context,
                            successful_attempt_view: &successful_attempt_view,
                            provider_response_transport_intent: V3HubTransportIntent::Sse,
                            tool_thinking_enabled: request_tool_thinking_enabled,
                            tool_thinking_turn_context: &request_tool_thinking_turn_context,
                            compatibility_profile: selected
                                .candidate
                                .compatibility_profile
                                .as_deref(),
                            web_search_execution_mode: selected.candidate.web_search_execution_mode,
                            // web_search 当前轮拦截直接使用 Req04
                            // 激活的 LocalToolSurfaceActive state（request_web_search_state），
                            // 不依赖其他控制面状态。
                            web_search_center_state: request_web_search_state.clone().or_else(
                                || {
                                    server_tool_state
                                        .as_ref()
                                        .and_then(|execution| {
                                            execution
                                                .control
                                                .web_search_load_for_scope(&execution.scope)
                                                .ok()
                                        })
                                        .flatten()
                                },
                            ),
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
                if let Some(web_search_state) = response_web_search_state {
                    // MiniMax hosted search：结果已随同一响应返回
                    // （SearchResultCaptured）→ 跳过本地搜索 hop；否则走
                    // backend direct pin 的搜索 hop。
                    let captured = if web_search_state.phase()
                        == V3WebSearchCenterPhase::SearchResultCaptured
                    {
                        web_search_state
                    } else {
                        let execution = server_tool_state.as_ref().ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
                                "web_search execution scope is unavailable".to_string(),
                            )
                        })?;
                        execute_web_search_through_hooks_sidecar(
                            execution.control.hooks_sidecar_socket(),
                            &input.request_id,
                            &execution.scope,
                            &request_execution_control,
                            &web_search_state,
                        )
                        .await?
                    };
                    project_web_search_result_into_finalized(
                        &mut finalized_provider_value,
                        &captured,
                    )?;
                    if let Some(execution) = server_tool_state.as_ref() {
                        if execution.commit_effects && execution.scope.has_client_session_scope() {
                            execution.control.web_search_store_for_scope(
                                &execution.scope,
                                captured,
                                V3ServerToolCenterWriteOrigin {
                                    module: "responses_relay_runtime",
                                    symbol: "web_search_store_for_scope",
                                    stage: "resp03_commit_effects",
                                },
                                Some("resp03 commit effects persist captured web_search state"),
                                None,
                            )?;
                        }
                    }
                }
                let attempt_success_receipt =
                    crate::nodes::V3AttemptSuccessReceipt::from_protocol_terminal_attempt();
                let _ = (
                    &attempt_success_receipt,
                    &local_tool_output_ids.consumed_ids,
                );
                handle_error_before_resp03!(provider_health
                    .record_provider_success_in_failure_scope(
                        &attempt_success_receipt,
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
                    stream_observation: if client_response_is_sse {
                        Some(stream_observation)
                    } else {
                        None
                    },
                    finalized_response: Some(finalized_response),
                    provider_snapshots: None,
                    protocol_direct_handoff: None,
                    request_finalizer: None,
                });
            }
        }
}
