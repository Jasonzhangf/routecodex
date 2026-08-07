use super::*;

pub(super) enum V3ResponsesDirectServerOutcome {
    DirectFrame(V3Server16HttpFrame),
    RelayOutput(V3ResponsesRelayRuntimeOutput),
}

pub(super) async fn execute_responses_direct_server_outcome(
    state: &V3ListenerState,
    request_headers: &HeaderMap,
    method: String,
    path: String,
    request_id: String,
    execution_id: String,
    payload: serde_json::Value,
    responses_protocol_plan: Option<&V3ResponsesProtocolExecutionPlan>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
) -> V3ResponsesDirectServerOutcome {
    let requested_stream = v3_responses_request_wants_sse(request_headers, &payload);
    let entry_facts = V3ResponsesContinuationEntryFacts::project(&payload);
    let continuation_scope = match build_responses_direct_continuation_scope(
        request_headers,
        &request_id,
        &state.server,
        &path,
        &entry_facts,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            let frame = build_v3_server_16_http_frame_from_v3_error_06(project_http_input_error(
                V3HttpBoundaryErrorKind::MalformedJson,
                message,
            ));
            return V3ResponsesDirectServerOutcome::DirectFrame(
                project_v3_responses_direct_stream_error_frame_if_requested(
                    frame,
                    requested_stream,
                ),
            );
        }
    };
    let relay_continuation_scope = match build_responses_relay_local_continuation_scope(
        request_headers,
        &request_id,
        &state.server,
        &path,
        &entry_facts,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            let frame = build_v3_server_16_http_frame_from_v3_error_06(project_http_input_error(
                V3HttpBoundaryErrorKind::MalformedJson,
                message,
            ));
            return V3ResponsesDirectServerOutcome::DirectFrame(
                project_v3_responses_direct_stream_error_frame_if_requested(
                    frame,
                    requested_stream,
                ),
            );
        }
    };
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(error) => {
            let frame =
                build_v3_server_16_http_frame_from_v3_foundation_output(project_v3_debug_failure(
                    "V3HubReqContinuation03Classified",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ));
            return V3ResponsesDirectServerOutcome::DirectFrame(
                project_v3_responses_direct_stream_error_frame_if_requested(
                    frame,
                    requested_stream,
                ),
            );
        }
    };
    let provider_failure_session_scope =
        get_failure_session_scope(&state.server, request_headers, "responses", &request_id)
            .expect("responses continuation requires session-id for failure scope");
    let raw = build_v3_server_03_http_request_raw(
        state.server.id.clone(),
        provider_failure_session_scope.clone(),
        request_id.clone(),
        execution_id.clone(),
        method.clone(),
        path.clone(),
        payload.clone(),
    );
    let output = match responses_protocol_plan {
        Some(plan) => {
            execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
                V3ResponsesDirectRuntimeSharedState::new(
                    &state.responses_direct_continuation,
                    &state.responses_direct_stopless_control,
                    state.provider_health.runtime_health(),
                )
                .with_provider_failure_event_sink(
                    provider_failure_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                )
                .with_route_selection_event_sink(
                    route_selection_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                ),
                &state.manifest,
                raw,
                continuation_scope,
                register_responses_direct_hooks(),
                &state.debug,
                now_epoch_ms,
                plan,
                observability_accumulator,
            )
            .await
        }
        None => {
            execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
                V3ResponsesDirectRuntimeSharedState::new(
                    &state.responses_direct_continuation,
                    &state.responses_direct_stopless_control,
                    state.provider_health.runtime_health(),
                )
                .with_provider_failure_event_sink(
                    provider_failure_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                )
                .with_route_selection_event_sink(
                    route_selection_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                ),
                &state.manifest,
                raw,
                continuation_scope,
                register_responses_direct_hooks(),
                &state.debug,
                now_epoch_ms,
            )
            .await
        }
    };
    if let Some(handoff) = output.protocol_relay_handoff {
        let runtime_input = V3ResponsesRelayRuntimeInput {
            server_id: state.server.id.clone(),
            failure_session_scope: provider_failure_session_scope,
            request_id: request_id.clone(),
            payload: payload.clone(),
        };
        let mut local_stopless = V3ResponsesRelayLocalStoplessControlInput::new(
            &state.responses_relay_local_continuation,
            &state.responses_relay_stopless_control,
            relay_continuation_scope,
            now_epoch_ms,
        );
        if let Some(sink) = provider_failure_event_sink.as_ref() {
            local_stopless = local_stopless.with_provider_failure_event_sink(Arc::clone(sink));
        }
        if let Some(sink) = route_selection_event_sink.as_ref() {
            local_stopless = local_stopless.with_route_selection_event_sink(Arc::clone(sink));
        }
        let capture_provider_request = state
            .debug
            .should_capture_snapshot_stage("provider-request");
        let capture_provider_response = state
            .debug
            .should_capture_snapshot_stage("provider-response");
        let relay_result = if capture_provider_request || capture_provider_response {
            execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_provider_snapshots_and_initial_target(
                &state.manifest,
                runtime_input,
                &state.provider_health,
                local_stopless,
                V3ResponsesRelayProviderSnapshotCapture::new(
                    capture_provider_request,
                    capture_provider_response,
                ),
                handoff.target,
                handoff.expanded,
                handoff.request_local_excluded_candidates,
                Some(handoff.observability_accumulator),
            )
            .await
        } else {
            execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target(
                &state.manifest,
                runtime_input,
                &state.provider_health,
                local_stopless,
                handoff.target,
                handoff.expanded,
                handoff.request_local_excluded_candidates,
                Some(handoff.observability_accumulator),
            )
            .await
        };
        let mut relay_output = match relay_result {
            Ok(output) => output,
            Err(error) => project_v3_responses_relay_runtime_failure(error),
        };
        prepend_v3_protocol_plan_trace_to_responses_relay_output(
            &mut relay_output,
            &handoff.node_trace,
        );
        merge_v3_direct_handoff_provider_failure_events(
            &mut relay_output,
            handoff.provider_failure_events,
        );
        if let Some(next_handoff) = relay_output.protocol_direct_handoff.take() {
            let relay_trace = merge_v3_protocol_plan_trace(
                relay_output.node_trace.clone(),
                next_handoff.node_trace.clone(),
            );
            let mut relay_events = relay_output
                .observability
                .as_ref()
                .map(|observability| observability.provider_failure_events.clone())
                .unwrap_or_default();
            relay_events.extend(next_handoff.provider_failure_events);
            let nested_outcome = Box::pin(execute_responses_direct_server_outcome(
                state,
                request_headers,
                method,
                path,
                request_id,
                execution_id,
                next_handoff.request_payload.clone(),
                Some(&next_handoff.plan),
                Some(next_handoff.observability_accumulator),
                provider_failure_event_sink,
                route_selection_event_sink,
            ))
            .await;
            return match nested_outcome {
                V3ResponsesDirectServerOutcome::DirectFrame(mut frame) => {
                    prepend_v3_relay_handoff_trace_to_direct_frame(&mut frame, &relay_trace);
                    merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
                        &mut frame,
                        relay_events,
                    );
                    V3ResponsesDirectServerOutcome::DirectFrame(frame)
                }
                V3ResponsesDirectServerOutcome::RelayOutput(mut output) => {
                    prepend_v3_protocol_plan_trace_to_responses_relay_output(
                        &mut output,
                        &relay_trace,
                    );
                    merge_v3_direct_handoff_provider_failure_events(&mut output, relay_events);
                    V3ResponsesDirectServerOutcome::RelayOutput(output)
                }
            };
        }
        return V3ResponsesDirectServerOutcome::RelayOutput(relay_output);
    }
    let scope = match state
        .debug
        .start_trace(&state.server.id, &request_id, &execution_id)
    {
        Ok(scope) => scope,
        Err(error) => {
            let frame = build_v3_server_16_http_frame_from_v3_foundation_output(
                project_v3_debug_failure("V3Debug01TraceContextStarted", error),
            );
            return V3ResponsesDirectServerOutcome::DirectFrame(
                project_v3_responses_direct_stream_error_frame_if_requested(
                    frame,
                    requested_stream,
                ),
            );
        }
    };
    if let Err(error) = state.debug.record_node_event(
        &scope,
        "V3Server16HttpFrame",
        "projected",
        Some(json!({"status": output.client_payload.status})),
    ) {
        return V3ResponsesDirectServerOutcome::DirectFrame(
            build_v3_server_16_http_frame_from_v3_foundation_output(project_v3_debug_failure(
                "V3Server16HttpFrame",
                error,
            )),
        );
    }
    let mut frame = build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    );
    frame.observability = output.observability;
    frame.stream_observation = output.stream_observation;
    V3ResponsesDirectServerOutcome::DirectFrame(
        project_v3_responses_direct_stream_error_frame_if_requested(frame, requested_stream),
    )
}
