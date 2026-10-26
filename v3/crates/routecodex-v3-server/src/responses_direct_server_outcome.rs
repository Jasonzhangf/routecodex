use super::*;

pub(super) enum V3ResponsesDirectServerOutcome {
    DirectFrame(V3Server16HttpFrame),
    RelayOutput(V3ResponsesRelayRuntimeOutput),
    ProviderTerminal(V3ResponsesDirectTerminalOutcome),
}

pub(super) struct V3ResponsesDirectTerminalOutcome {
    pub disposition: routecodex_v3_error::V3ProviderTerminalDisposition,
    pub node_trace: Vec<&'static str>,
    pub observability: Option<V3RuntimeObservability>,
    pub diagnostic_source: Option<routecodex_v3_error::V3Error01SourceRaised>,
    pub diagnostic_cause: Option<routecodex_v3_error::V3Error01SourceRaised>,
    pub error_chain: Option<Vec<&'static str>>,
    pub status: u16,
}

impl V3ResponsesDirectServerOutcome {
    pub(super) fn prepend_observations(
        &mut self,
        trace: &[&'static str],
        failures: Vec<V3RuntimeProviderFailureObservation>,
    ) {
        match self {
            Self::DirectFrame(frame) => {
                prepend_v3_relay_handoff_trace_to_direct_frame(frame, trace);
                merge_v3_relay_handoff_provider_failure_events_into_direct_frame(frame, failures);
            }
            Self::RelayOutput(output) => {
                prepend_v3_protocol_plan_trace_to_responses_relay_output(output, trace);
                merge_v3_direct_handoff_provider_failure_events(output, failures);
            }
            Self::ProviderTerminal(terminal) => {
                terminal.node_trace = merge_v3_protocol_plan_trace(
                    trace.to_vec(),
                    std::mem::take(&mut terminal.node_trace),
                );
                let observation = terminal.observability.get_or_insert_with(Default::default);
                let mut combined = failures;
                combined.append(&mut observation.provider_failure_events);
                observation.provider_failure_events = combined;
            }
        }
    }

    pub(super) fn publish_observations(
        &self,
        state: &V3ListenerState,
        scope: Option<&V3DebugTraceScope>,
        entry_protocol: &str,
        path: &str,
        request_id: &str,
    ) {
        match self {
            Self::DirectFrame(frame) => publish_v3_responses_closeout_observations(
                state,
                scope,
                entry_protocol,
                path,
                request_id,
                &frame.node_trace,
                (!frame.error_chain.is_empty()).then_some(frame.error_chain.as_slice()),
                frame.observability.as_ref(),
                frame.diagnostic_source.as_ref(),
                frame.diagnostic_cause.as_ref(),
            ),
            Self::RelayOutput(output) => publish_v3_responses_closeout_observations(
                state,
                scope,
                entry_protocol,
                path,
                request_id,
                &output.node_trace,
                output.error_chain.as_deref(),
                output.observability.as_ref(),
                output.diagnostic_source.as_ref(),
                output.diagnostic_cause.as_ref(),
            ),
            Self::ProviderTerminal(terminal) => {
                publish_responses_direct_terminal_outcome(state, scope, path, request_id, terminal)
            }
        }
    }
}

pub(super) fn take_responses_direct_terminal_outcome(
    output: &mut routecodex_v3_runtime::V3ResponsesDirectRuntimeOutput,
) -> Option<V3ResponsesDirectServerOutcome> {
    let disposition = output.terminal_disposition.take()?;
    Some(V3ResponsesDirectServerOutcome::ProviderTerminal(
        V3ResponsesDirectTerminalOutcome {
            disposition,
            node_trace: output.node_trace.clone(),
            observability: output.observability.clone(),
            diagnostic_source: output.diagnostic_source.clone(),
            diagnostic_cause: output.diagnostic_cause.clone(),
            error_chain: output.error_chain.clone(),
            status: output.client_payload.status,
        },
    ))
}

fn publish_responses_direct_terminal_outcome(
    state: &V3ListenerState,
    scope: Option<&V3DebugTraceScope>,
    path: &str,
    request_id: &str,
    output: &V3ResponsesDirectTerminalOutcome,
) {
    publish_v3_responses_closeout_observations(
        state,
        scope,
        "responses",
        path,
        request_id,
        &output.node_trace,
        output.error_chain.as_deref(),
        output.observability.as_ref(),
        output.diagnostic_source.as_ref(),
        output.diagnostic_cause.as_ref(),
    );
    // A Responses Direct provider terminal ends the client transport without a
    // client payload, so the request never reaches the Direct frame closeout
    // that would write its terminal observability row. Record the already-typed
    // Error06 chain before breaking the transport: the Direct lane really holds
    // `V3Error06ClientProjected`, so the terminal row keeps the real chain
    // instead of reading "not_reached" or, worse, leaving no row at all.
    //
    // The typed terminal disposition and Error01 source travel with the chain so
    // the ledger derives `provider_status`/`error_category` from the real
    // provider terminal, never from the projected client status. A client
    // disconnect terminal records `request.cancelled` here instead of being
    // skipped: this lane does not run the Direct frame closeout, so skipping it
    // would leave the request without any terminal row.
    let error_chain = output.error_chain.as_deref();
    if error_chain.is_some() || output.diagnostic_source.is_some() {
        if let Err(error) = webui_observability::record_v3_webui_error_projection(
            &state.webui_observability,
            state.server.port,
            request_id,
            path,
            "responses",
            None,
            None,
            output.status,
            None,
            webui_observability::V3ObsErrorProjection {
                exposed: error_chain.is_some(),
                error_chain: error_chain.unwrap_or(&[]),
                diagnostic_source: output.diagnostic_source.as_ref(),
                terminal_disposition: Some(&output.disposition),
                ..Default::default()
            },
        ) {
            let line = format_v3_console_timed_content(
                "[webui-observability]",
                &format!("req={} error={}", request_id, error),
            );
            append_v3_human_console_line(state, &line);
        }
    }
}

pub(super) fn execute_responses_direct_server_outcome<'a>(
    state: &'a V3ListenerState,
    request_headers: &'a HeaderMap,
    method: String,
    path: String,
    request_id: String,
    pipeline_id: Option<String>,
    execution_id: String,
    payload: serde_json::Value,
    responses_protocol_plan: Option<&'a V3ResponsesProtocolExecutionPlan>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    request_execution_control: Option<V3RequestExecutionControl>,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    client_frame_sink: Option<routecodex_v3_runtime::V3CommittedClientFrameSink>,
    request_purpose: V3RequestPurpose,
) -> std::pin::Pin<Box<impl std::future::Future<Output = V3ResponsesDirectServerOutcome> + Send + 'a>>
{
    // Construct this future outside the shared protocol-dispatch poll frame.
    Box::pin(execute_responses_direct_server_outcome_inner(
        state,
        request_headers,
        method,
        path,
        request_id,
        pipeline_id,
        execution_id,
        payload,
        responses_protocol_plan,
        observability_accumulator,
        request_execution_control,
        provider_failure_event_sink,
        route_selection_event_sink,
        client_frame_sink,
        request_purpose,
    ))
}

async fn execute_responses_direct_server_outcome_inner(
    state: &V3ListenerState,
    request_headers: &HeaderMap,
    method: String,
    path: String,
    request_id: String,
    pipeline_id: Option<String>,
    execution_id: String,
    payload: serde_json::Value,
    responses_protocol_plan: Option<&V3ResponsesProtocolExecutionPlan>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
    request_execution_control: Option<V3RequestExecutionControl>,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    client_frame_sink: Option<routecodex_v3_runtime::V3CommittedClientFrameSink>,
    request_purpose: V3RequestPurpose,
) -> V3ResponsesDirectServerOutcome {
    let requested_stream = v3_request_wants_sse(request_headers, &payload);
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(error) => {
            let frame =
                build_v3_server_16_http_frame_from_v3_foundation_output(project_v3_debug_failure(
                    "V3ServerReqChatProcess03Governed",
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
        match get_failure_session_scope(&state.server, request_headers, &request_id) {
            Ok(scope) => scope,
            Err(message) => {
                let frame = build_v3_server_16_http_frame_from_error_sdk_result(
                    "V3Server03HttpRequestRaw",
                    project_v3_server_boundary_error_via_sdk(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3Server03HttpRequestRaw",
                        "provider_transport_handoff_scope_incomplete",
                        message,
                        Some(598),
                    ),
                );
                return V3ResponsesDirectServerOutcome::DirectFrame(
                    project_v3_responses_direct_stream_error_frame_if_requested(
                        frame,
                        requested_stream,
                    ),
                );
            }
        };
    let pipeline_id = match pipeline_id {
        Some(pipeline_id) if !pipeline_id.trim().is_empty() => pipeline_id,
        _ => {
            let frame = build_v3_server_16_http_frame_from_error_sdk_result(
                "V3Transport13ResponsesHttpRequest",
                project_v3_server_boundary_error_via_sdk(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3Transport13ResponsesHttpRequest",
                    "provider_transport_handoff_scope_incomplete",
                    "Responses direct handoff is missing pipeline_id",
                    Some(598),
                ),
            );
            return V3ResponsesDirectServerOutcome::DirectFrame(
                project_v3_responses_direct_stream_error_frame_if_requested(
                    frame,
                    requested_stream,
                ),
            );
        }
    };
    let provider_failure_session_scope = match provider_failure_session_scope
        .with_transport_handoff_scope(
            pipeline_id.clone(),
            state.server.port,
            state.front_transport_broker.generation(),
        ) {
        Ok(scope) => scope,
        Err(message) => {
            let frame = build_v3_server_16_http_frame_from_error_sdk_result(
                "V3Transport13ResponsesHttpRequest",
                project_v3_server_boundary_error_via_sdk(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3Transport13ResponsesHttpRequest",
                    "provider_transport_handoff_scope_incomplete",
                    message,
                    Some(598),
                ),
            );
            return V3ResponsesDirectServerOutcome::DirectFrame(
                project_v3_responses_direct_stream_error_frame_if_requested(
                    frame,
                    requested_stream,
                ),
            );
        }
    };
    let raw = build_v3_server_03_http_request_raw_with_purpose_and_scope(
        state.server.id.clone(),
        provider_failure_session_scope.clone(),
        request_id.clone(),
        execution_id.clone(),
        method.clone(),
        path.clone(),
        request_purpose,
        Some(state.server.port),
        Some(pipeline_id.clone()),
        payload.clone(),
    );
    let mut output = match responses_protocol_plan {
        Some(plan) => {
            execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
                V3ResponsesDirectRuntimeSharedState::new(state.provider_health.runtime_health())
                .with_provider_failure_event_sink(
                    provider_failure_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                )
                .with_route_selection_event_sink(
                    route_selection_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                )
                .with_client_frame_sink(client_frame_sink.clone())
                .defer_debug_node_publication_to_server(),
                &state.manifest,
                raw,
                register_responses_direct_hooks(),
                &state.debug,
                now_epoch_ms,
                plan,
                observability_accumulator,
                request_execution_control,
            )
            .await
        }
        None => {
            execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
                V3ResponsesDirectRuntimeSharedState::new(state.provider_health.runtime_health())
                .with_provider_failure_event_sink(
                    provider_failure_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                )
                .with_route_selection_event_sink(
                    route_selection_event_sink
                        .as_ref()
                        .map(std::sync::Arc::clone),
                )
                .with_client_frame_sink(client_frame_sink.clone())
                .defer_debug_node_publication_to_server(),
                &state.manifest,
                raw,
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
        let capture_provider_request = state
            .debug
            .should_capture_snapshot_stage("provider-request");
        let capture_provider_response = state
            .debug
            .should_capture_snapshot_stage("provider-response");
        let relay_runtime_seeds = handoff.relay_runtime_seeds();
        let relay_result = if capture_provider_request || capture_provider_response {
            execute_v3_responses_relay_runtime_with_default_transport_health(
                &state.manifest,
                runtime_input,
                &state.provider_health,
                V3ResponsesRelayProviderSnapshotCapture::new(
                    capture_provider_request,
                    capture_provider_response,
                ),
                provider_failure_event_sink
                    .as_ref()
                    .map(std::sync::Arc::clone),
                route_selection_event_sink
                    .as_ref()
                    .map(std::sync::Arc::clone),
                Some(handoff.target),
                Some(handoff.expanded),
                handoff.request_local_excluded_candidates,
                relay_runtime_seeds,
            )
            .await
        } else {
            execute_v3_responses_relay_runtime_with_default_transport_health(
                &state.manifest,
                runtime_input,
                &state.provider_health,
                V3ResponsesRelayProviderSnapshotCapture::new(false, false),
                provider_failure_event_sink
                    .as_ref()
                    .map(std::sync::Arc::clone),
                route_selection_event_sink
                    .as_ref()
                    .map(std::sync::Arc::clone),
                Some(handoff.target),
                Some(handoff.expanded),
                handoff.request_local_excluded_candidates,
                relay_runtime_seeds,
            )
            .await
        };
        let mut relay_output = match relay_result {
            Ok(output) => output,
            Err(error) => project_v3_responses_relay_runtime_failure(error, None),
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
            let relay_trace = relay_output.node_trace.clone();
            let mut relay_events = relay_output
                .observability
                .as_ref()
                .map(|observability| observability.provider_failure_events.clone())
                .unwrap_or_default();
            relay_events.extend(next_handoff.provider_failure_events);
            let request_execution_control = next_handoff.request_execution_control;
            let mut nested_outcome = Box::pin(execute_responses_direct_server_outcome(
                state,
                request_headers,
                method,
                path,
                request_id,
                Some(pipeline_id.clone()),
                execution_id,
                next_handoff.request_payload.clone(),
                Some(&next_handoff.plan),
                Some(next_handoff.observability_accumulator),
                Some(request_execution_control),
                provider_failure_event_sink,
                route_selection_event_sink,
                client_frame_sink.clone(),
                request_purpose,
            ))
            .await;
            nested_outcome.prepend_observations(&relay_trace, relay_events);
            return nested_outcome;
        }
        return V3ResponsesDirectServerOutcome::RelayOutput(relay_output);
    }
    if capture_v3_responses_direct_provider_snapshots(
        state,
        "responses",
        &path,
        &request_id,
        &mut output,
    )
    .is_some()
    {
        eprintln!("V3 Direct provider snapshot capture failed; retaining the runtime outcome");
    }
    if let Some(terminal) = take_responses_direct_terminal_outcome(&mut output) {
        return terminal;
    }
    let mut frame = build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    );
    frame.observability = output.observability;
    frame.stream_observation = output.stream_observation;
    frame.diagnostic_source = output.diagnostic_source;
    frame.diagnostic_cause = output.diagnostic_cause;
    V3ResponsesDirectServerOutcome::DirectFrame(
        project_v3_responses_direct_stream_error_frame_if_requested(frame, requested_stream),
    )
}
