use crate::*;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Response};
use axum::body::Body;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

pub(crate) async fn pending_endpoint_after_responses_admission(
    state: Arc<V3ListenerState>,
    request_headers: HeaderMap,
    method: String,
    path: String,
    started_at: Instant,
    entry_protocol: String,
    mut execution_mode: V3EntryProtocolExecutionMode,
    pending_owner_symbol: Option<String>,
    payload: Value,
) -> Response<Body> {
    let request_identity = match allocate_v3_console_request_identity(&state, &path, Some(&payload))
    {
        Ok(request_identity) => request_identity,
        Err(response) => return *response,
    };
    let request_id = request_identity.request_id.clone();
    let responses_entry_facts = (entry_protocol == "responses")
        .then(|| V3ResponsesContinuationEntryFacts::project(&payload));
    let execution_id = state.debug.next_execution_id(&state.server.id);
    let trace_scope = match state
        .debug
        .start_trace(&state.server.id, &request_id, &execution_id)
    {
        Ok(scope) => scope,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3Server03HttpRequestRaw",
                error,
            ));
        }
    };
    if let Err(error) = state.debug.record_node_event(
        &trace_scope,
        "V3Server03HttpRequestRaw",
        "received",
        Some(json!({
            "method": method.clone(),
            "path": path.clone(),
            "entry_protocol": entry_protocol.clone(),
            "execution_mode": execution_mode.as_str(),
            "server_id": state.server.id.clone()
        })),
    ) {
        return foundation_output_response(project_v3_debug_failure(
            "V3Server03HttpRequestRaw",
            error,
        ));
    }
    if entry_protocol == "responses" {
        let owner_resolution_context =
            match build_responses_previous_response_owner_resolution_context(
                &request_headers,
                &request_id,
                &state.server,
                &path,
                responses_entry_facts
                    .as_ref()
                    .expect("Responses entry facts are projected for Responses requests"),
            ) {
                Ok(context) => context,
                Err(message) => {
                    let frame = build_v3_server_16_http_frame_from_v3_error_06(
                        project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
                    );
                    if let Some(response) = record_and_emit_v3_error_projection(
                        &state,
                        &trace_scope,
                        V3ErrorProjectionConsoleInput {
                            endpoint: &path,
                            request_id: &request_id,
                            status: frame.status,
                            error_chain: &frame.error_chain,
                            body: match &frame.body {
                                V3Server16Body::Json(value) => Some(value),
                                V3Server16Body::Bytes(_) | V3Server16Body::Sse(_) => None,
                            },
                            project_path: resolve_v3_console_project_path(
                                &request_headers,
                                &payload,
                            )
                            .as_deref(),
                        },
                    ) {
                        return response;
                    }
                    let frame = project_v3_responses_error_frame_for_request_if_sse(
                        frame,
                        &request_headers,
                        Some(&payload),
                    );
                    return responses_direct_output_response(
                        frame,
                        Duration::from_millis(state.server.http_sse_keepalive_ms),
                    );
                }
            };
        match resolve_v3_responses_previous_response_owner_execution_mode_at_req03(
            responses_entry_facts
                .as_ref()
                .and_then(|facts| facts.previous_response_id.as_deref()),
            execution_mode,
            &state.responses_direct_continuation,
            &state.responses_relay_local_continuation,
            owner_resolution_context
                .as_ref()
                .map(|context| &context.direct_scope),
            owner_resolution_context
                .as_ref()
                .map(|context| &context.relay_scope),
            owner_resolution_context
                .as_ref()
                .map(|context| context.now_epoch_ms)
                .unwrap_or(0),
        ) {
            Ok(resolved) => execution_mode = resolved,
            Err(error) => {
                let frame = build_v3_server_16_http_frame_from_v3_error_06(
                    project_v3_responses_previous_response_owner_resolution_error(error),
                );
                if let Some(response) = record_and_emit_v3_error_projection(
                    &state,
                    &trace_scope,
                    V3ErrorProjectionConsoleInput {
                        endpoint: &path,
                        request_id: &request_id,
                        status: frame.status,
                        error_chain: &frame.error_chain,
                        body: match &frame.body {
                            V3Server16Body::Json(value) => Some(value),
                            V3Server16Body::Bytes(_) | V3Server16Body::Sse(_) => None,
                        },
                        project_path: resolve_v3_console_project_path(&request_headers, &payload)
                            .as_deref(),
                    },
                ) {
                    return response;
                }
                let frame = project_v3_responses_error_frame_for_request_if_sse(
                    frame,
                    &request_headers,
                    Some(&payload),
                );
                return responses_direct_output_response(
                    frame,
                    Duration::from_millis(state.server.http_sse_keepalive_ms),
                );
            }
        }
    }
    let provider_failure_session_scope = match get_failure_session_scope(
        &state.server,
        &request_headers,
        &entry_protocol,
        &request_id,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            return error_output_response_for_server_with_project_path(
                &state.server,
                &path,
                &request_id,
                project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
                None,
            );
        }
    };
    let responses_protocol_plan = None;
    if entry_protocol == "responses" {
        if let Some(entry_facts) = responses_entry_facts.as_ref() {
            execution_mode =
                responses_effective_execution_mode_for_entry_facts(execution_mode, entry_facts);
        }
    }
    if execution_mode == V3EntryProtocolExecutionMode::Relay {
        if let Some(response) = capture_v3_live_raw_request(
            &state,
            &trace_scope,
            &entry_protocol,
            execution_mode,
            &path,
            &request_id,
            &payload,
        ) {
            return response;
        }
    }
    let snapshot_session_id = if entry_protocol == "responses" {
        match start_v3_live_snapshot_session(&state, &trace_scope) {
            Ok(session_id) => session_id,
            Err(response) => return *response,
        }
    } else {
        None
    };
    let request_console_project_path = resolve_v3_console_project_path(&request_headers, &payload);
    if is_provider_request_dry_run(&request_headers)
        && entry_protocol == "responses"
        && execution_mode == V3EntryProtocolExecutionMode::Direct
    {
        let fixture = V3DryRunFixture {
            fixture_id: request_id.clone(),
            server_id: state.server.id.clone(),
            method,
            path: path.clone(),
            request_payload: payload.clone(),
            response_payload: json!({
                "object": "response",
                "status": "completed",
                "output_text": "routecodex provider-request dry-run stopped before provider send",
                "output": [{"type":"output_text","text":"routecodex provider-request dry-run stopped before provider send"}]
            }),
        };
        let output = match responses_protocol_plan.as_ref() {
            Some(plan) => {
                execute_v3_responses_direct_dry_run_runtime_with_initial_target(
                    fixture,
                    &state.manifest,
                    &state.debug,
                    plan,
                )
                .await
            }
            None => {
                execute_v3_responses_direct_dry_run_runtime(fixture, &state.manifest, &state.debug)
                    .await
            }
        };
        let raw_input_items = payload
            .get("input")
            .and_then(Value::as_array)
            .map_or(1, Vec::len);
        emit_v3_dry_run_console_lines(
            &build_v3_console_emission_context(
                &state,
                &entry_protocol,
                &path,
                &request_identity,
                &request_headers,
                &payload,
            ),
            &resolve_v3_dry_run_target_label(&state),
            "provider-request-dry-run",
            raw_input_items,
            raw_input_items,
            output.status,
            output.node_trace.len(),
        );
        if let Err(error) = persist_v3_codex_sample_payload(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            "request.json",
            &payload,
        ) {
            return foundation_output_response(project_v3_debug_failure(
                "V3DebugProviderRequestCaptured",
                V3DebugError::Sink(error),
            ));
        }
        if let Err(error) = persist_v3_codex_sample_payload(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            "response.json",
            &output.body,
        ) {
            return foundation_output_response(project_v3_debug_failure(
                "V3DebugProviderResponseCaptured",
                V3DebugError::Sink(error),
            ));
        }
        if let Some(response) = record_v3_live_snapshot_projection(
            &state,
            &trace_scope,
            snapshot_session_id.as_deref(),
            output.status,
            &output.node_trace,
            "provider_request_dry_run",
        ) {
            return response;
        }
        if let Some(response) = capture_v3_foundation_runtime_response(
            &state,
            &trace_scope,
            &entry_protocol,
            execution_mode,
            &path,
            &request_id,
            &output,
        ) {
            return response;
        }
        return foundation_output_response(output);
    }
    if is_provider_request_dry_run(&request_headers)
        && entry_protocol == "responses"
        && execution_mode == V3EntryProtocolExecutionMode::Relay
    {
        let continuation_scope = match build_responses_relay_local_continuation_scope(
            &request_headers,
            &request_id,
            &state.server,
            &path,
            responses_entry_facts
                .as_ref()
                .expect("Responses entry facts are projected for Responses requests"),
        ) {
            Ok(scope) => scope,
            Err(message) => {
                return error_output_response_for_responses_request_with_project_path(
                    &state.server,
                    &path,
                    &request_id,
                    project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
                    &request_headers,
                    Some(&payload),
                    request_console_project_path.as_deref(),
                );
            }
        };
        let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        {
            Ok(duration) => duration.as_millis() as u64,
            Err(error) => {
                return foundation_output_response(project_v3_debug_failure(
                    "V3HubReqContinuation03Classified",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ));
            }
        };
        let output = match execute_v3_responses_relay_dry_run_orchestration_outcome_with_local_continuation_and_stopless_control(
            &state.manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: state.server.id.clone(),
                failure_session_scope: provider_failure_session_scope.clone(),
                request_id: request_id.clone(),
                payload: payload.clone(),
            },
            &state.responses_relay_local_continuation,
            &state.responses_relay_stopless_control,
            continuation_scope,
            now_epoch_ms,
        )
        .await
        {
            V3ResponsesRelayDryRunOutcome::Foundation(output) => output,
            V3ResponsesRelayDryRunOutcome::DirectHandoff(handoff) => {
                let fixture = V3DryRunFixture {
                    fixture_id: request_id.clone(),
                    server_id: state.server.id.clone(),
                    method: method.clone(),
                    path: path.clone(),
                    request_payload: handoff.request_payload,
                    response_payload: json!({
                        "object": "response",
                        "status": "completed",
                        "output_text": "routecodex provider-request dry-run stopped before provider send",
                        "output": [{"type":"output_text","text":"routecodex provider-request dry-run stopped before provider send"}]
                    }),
                };
                let mut output = execute_v3_responses_direct_dry_run_runtime_with_initial_target(
                    fixture,
                    &state.manifest,
                    &state.debug,
                    &handoff.plan,
                )
                .await;
                prepend_v3_protocol_plan_trace_to_foundation_output(
                    &mut output,
                    &handoff.node_trace,
                );
                output
            }
        };
        let raw_input_items = payload
            .get("input")
            .and_then(Value::as_array)
            .map_or(1, Vec::len);
        emit_v3_dry_run_console_lines(
            &build_v3_console_emission_context(
                &state,
                &entry_protocol,
                &path,
                &request_identity,
                &request_headers,
                &payload,
            ),
            &resolve_v3_dry_run_target_label(&state),
            "provider-request-dry-run",
            raw_input_items,
            raw_input_items,
            output.status,
            output.node_trace.len(),
        );
        if let Some(response) = record_v3_live_snapshot_projection(
            &state,
            &trace_scope,
            snapshot_session_id.as_deref(),
            output.status,
            &output.node_trace,
            "provider_request_dry_run",
        ) {
            return response;
        }
        if let Some(response) = capture_v3_foundation_runtime_response(
            &state,
            &trace_scope,
            &entry_protocol,
            execution_mode,
            &path,
            &request_id,
            &output,
        ) {
            return response;
        }
        return foundation_output_response(output);
    }
    if is_provider_request_dry_run(&request_headers)
        && entry_protocol == "anthropic"
        && execution_mode == V3EntryProtocolExecutionMode::Relay
    {
        let client_headers = match collect_anthropic_relay_client_headers(&request_headers) {
            Ok(headers) => headers,
            Err(message) => {
                return error_output_response_for_server_with_project_path(
                    &state.server,
                    &path,
                    &request_id,
                    project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
                    request_console_project_path.as_deref(),
                );
            }
        };
        let output = execute_v3_anthropic_relay_dry_run_runtime_with_client_headers(
            &state.manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                failure_session_scope: provider_failure_session_scope.clone(),
                request_id: request_id.clone(),
                payload: payload.clone(),
            },
            client_headers,
        )
        .await;
        if let Some(response) = record_v3_live_snapshot_projection(
            &state,
            &trace_scope,
            snapshot_session_id.as_deref(),
            output.status,
            &output.node_trace,
            "provider_request_dry_run",
        ) {
            return response;
        }
        if let Some(response) = capture_v3_foundation_runtime_response(
            &state,
            &trace_scope,
            &entry_protocol,
            execution_mode,
            &path,
            &request_id,
            &output,
        ) {
            return response;
        }
        return foundation_output_response(output);
    }
    if entry_protocol == "openai_chat" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        return execute_v3_openai_chat_direct_server_outcome(
            &state,
            method,
            path.clone(),
            request_id.clone(),
            execution_id,
            payload,
            provider_failure_session_scope.clone(),
            &request_headers,
            &request_identity,
            started_at,
            request_console_project_path.as_deref(),
        )
        .await;
    }
    if entry_protocol == "openai_chat" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output =
            match execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
                &state.manifest,
                V3OpenAiChatRelayRuntimeInput {
                    server_id: state.server.id.clone(),
                    failure_session_scope: provider_failure_session_scope.clone(),
                    request_id: request_id.clone(),
                    payload: payload.clone(),
                },
                state.provider_health.runtime_health(),
            )
            .await
            {
                Ok(output) => output,
                Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
            };
        if let Some(response) = emit_relay_error_chain_if_any(
            &state,
            &trace_scope,
            &path,
            &request_id,
            output.status,
            output.error_chain.as_deref(),
            openai_chat_error_body_for_console(&output.client_body),
            request_console_project_path.as_deref(),
        ) {
            return response;
        }
        let mut output = output;
        if let Some(response) = capture_v3_openai_chat_relay_response(
            &state,
            &trace_scope,
            &entry_protocol,
            &path,
            &request_id,
            &payload,
            &mut output,
        ) {
            return response;
        }
        return openai_chat_relay_output_response(output);
    }
    if entry_protocol == "anthropic" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let stream = payload.get("stream").and_then(serde_json::Value::as_bool) == Some(true);
        let client_headers = match collect_anthropic_relay_client_headers(&request_headers) {
            Ok(headers) => headers,
            Err(message) => {
                return error_output_response_for_server_with_project_path(
                    &state.server,
                    &path,
                    &request_id,
                    project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
                    request_console_project_path.as_deref(),
                );
            }
        };
        let output = match execute_v3_anthropic_relay_runtime_with_default_transport_client_headers_provider_health(
            &state.manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                failure_session_scope: provider_failure_session_scope.clone(),
                request_id: request_id.clone(),
                payload: payload.clone(),
            },
            client_headers,
            state.provider_health.runtime_health(),
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_anthropic_relay_runtime_failure(error),
        };
        if let Some(response) = emit_relay_error_chain_if_any(
            &state,
            &trace_scope,
            &path,
            &request_id,
            output.status,
            output.error_chain.as_deref(),
            Some(&output.client_response),
            request_console_project_path.as_deref(),
        ) {
            return response;
        }
        return anthropic_relay_output_response(output, stream);
    }
    if entry_protocol == "gemini" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output = match execute_v3_gemini_relay_runtime_with_default_transport_provider_health(
            &state.manifest,
            V3GeminiRelayRuntimeInput {
                server_id: state.server.id.clone(),
                failure_session_scope: provider_failure_session_scope.clone(),
                request_id: request_id.clone(),
                endpoint_path: path.clone(),
                payload: payload.clone(),
            },
            state.provider_health.runtime_health(),
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_gemini_relay_runtime_failure(error),
        };
        if let Some(response) = emit_relay_error_chain_if_any(
            &state,
            &trace_scope,
            &path,
            &request_id,
            output.status,
            output.error_chain.as_deref(),
            gemini_error_body_for_console(&output.client_body),
            request_console_project_path.as_deref(),
        ) {
            return response;
        }
        return gemini_relay_output_response(output);
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let continuation_scope = match build_responses_relay_local_continuation_scope(
            &request_headers,
            &request_id,
            &state.server,
            &path,
            responses_entry_facts
                .as_ref()
                .expect("Responses entry facts are projected for Responses requests"),
        ) {
            Ok(scope) => scope,
            Err(message) => {
                return error_output_response_for_responses_request_with_project_path(
                    &state.server,
                    &path,
                    &request_id,
                    project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
                    &request_headers,
                    Some(&payload),
                    request_console_project_path.as_deref(),
                );
            }
        };
        let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        {
            Ok(duration) => duration.as_millis() as u64,
            Err(error) => {
                return foundation_output_response(project_v3_debug_failure(
                    "V3HubReqContinuation03Classified",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ));
            }
        };
        let console_payload = payload.clone();
        let runtime_input = V3ResponsesRelayRuntimeInput {
            server_id: state.server.id.clone(),
            failure_session_scope: provider_failure_session_scope.clone(),
            request_id: request_id.clone(),
            payload,
        };
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_identity,
            &request_headers,
            &console_payload,
        );
        let provider_failure_event_sink = build_v3_provider_failure_event_sink(&console_context);
        let route_selection_event_sink = build_v3_route_selection_event_sink(&console_context);
        // Keep raw provider attempts in the request-scoped recorder so terminal
        // errors can flush the original wire evidence even when normal debug
        // snapshot stages are disabled. Successful requests still persist only
        // explicitly enabled intermediate stages.
        let capture_provider_request = true;
        let capture_provider_response = true;
        let mut output = if capture_provider_request || capture_provider_response {
            match responses_protocol_plan.as_ref() {
                Some(plan) => match execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_provider_snapshots_and_initial_target(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    V3ResponsesRelayLocalStoplessControlInput::new(
                        &state.responses_relay_local_continuation,
                        &state.responses_relay_stopless_control,
                        continuation_scope.clone(),
                        now_epoch_ms,
                    )
                    .with_provider_failure_event_sink(provider_failure_event_sink.clone())
                    .with_route_selection_event_sink(route_selection_event_sink.clone()),
                    V3ResponsesRelayProviderSnapshotCapture::new(
                        capture_provider_request,
                        capture_provider_response,
                    ),
                    plan.decision.target.clone(),
                    plan.expanded.clone(),
                    BTreeSet::new(),
                    None,
                )
                .await
                {
                    Ok(mut output) => {
                        prepend_v3_protocol_plan_trace_to_responses_relay_output(
                            &mut output,
                            &plan.node_trace,
                        );
                        output
                    }
                    Err(error) => project_v3_responses_relay_runtime_failure(error),
                },
                None => match execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    V3ResponsesRelayLocalStoplessControlInput::new(
                        &state.responses_relay_local_continuation,
                        &state.responses_relay_stopless_control,
                        continuation_scope.clone(),
                        now_epoch_ms,
                    )
                    .with_provider_failure_event_sink(provider_failure_event_sink.clone())
                    .with_route_selection_event_sink(route_selection_event_sink.clone()),
                    V3ResponsesRelayProviderSnapshotCapture::new(
                        capture_provider_request,
                        capture_provider_response,
                    ),
                )
                .await
                {
                    Ok(output) => output,
                    Err(error) => project_v3_responses_relay_runtime_failure(error),
                },
            }
        } else {
            match responses_protocol_plan.as_ref() {
                Some(plan) => match execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    V3ResponsesRelayLocalStoplessControlInput::new(
                        &state.responses_relay_local_continuation,
                        &state.responses_relay_stopless_control,
                        continuation_scope.clone(),
                        now_epoch_ms,
                    )
                    .with_provider_failure_event_sink(provider_failure_event_sink.clone())
                    .with_route_selection_event_sink(route_selection_event_sink.clone()),
                    plan.decision.target.clone(),
                    plan.expanded.clone(),
                    BTreeSet::new(),
                    None,
                )
                .await
                {
                    Ok(mut output) => {
                        prepend_v3_protocol_plan_trace_to_responses_relay_output(
                            &mut output,
                            &plan.node_trace,
                        );
                        output
                    }
                    Err(error) => project_v3_responses_relay_runtime_failure(error),
                },
                None => match execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    V3ResponsesRelayLocalStoplessControlInput::new(
                        &state.responses_relay_local_continuation,
                        &state.responses_relay_stopless_control,
                        continuation_scope,
                        now_epoch_ms,
                    )
                    .with_provider_failure_event_sink(provider_failure_event_sink.clone())
                    .with_route_selection_event_sink(route_selection_event_sink.clone()),
                )
                .await
                {
                    Ok(output) => output,
                    Err(error) => project_v3_responses_relay_runtime_failure(error),
                },
            }
        };
        if output.protocol_direct_handoff.is_some() {
            if let Some(response) = capture_v3_responses_relay_provider_snapshots(
                &state,
                &entry_protocol,
                &path,
                &request_id,
                &mut output,
            ) {
                return response;
            }
        }
        if let Some(handoff) = output.protocol_direct_handoff.take() {
            let outcome = execute_responses_direct_server_outcome(
                &state,
                &request_headers,
                method,
                path.clone(),
                request_id.clone(),
                execution_id,
                handoff.request_payload.clone(),
                Some(&handoff.plan),
                Some(handoff.observability_accumulator),
                Some(provider_failure_event_sink.clone()),
                Some(route_selection_event_sink.clone()),
            )
            .await;
            match outcome {
                V3ResponsesDirectServerOutcome::DirectFrame(mut frame) => {
                    prepend_v3_relay_handoff_trace_to_direct_frame(&mut frame, &handoff.node_trace);
                    merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
                        &mut frame,
                        handoff.provider_failure_events,
                    );
                    // 可观测性：handoff direct 分支与纯 direct 分支对齐——status>=400
                    // 或 provider 失败时无条件落盘 request.json + error.json（绕过
                    // codex_samples 开关）。此前该分支只落 response.json，400/5xx
                    // 样本全部丢失，无法事后诊断（770577 等 400 无 error 样本）。
                    let has_provider_failure = frame.observability.as_ref().is_some_and(
                        |observability| !observability.provider_failure_events.is_empty(),
                    );
                    if frame.status >= 400 || has_provider_failure {
                        let _ = persist_v3_error_evidence_payload(
                            &state,
                            &entry_protocol,
                            &path,
                            &request_id,
                            "request.json",
                            &state
                                .debug
                                .project_payload_verbatim(handoff.request_payload.clone()),
                            (frame.status >= 400).then_some(frame.status),
                        );
                        let _ = persist_v3_error_evidence_payload(
                            &state,
                            &entry_protocol,
                            &path,
                            &request_id,
                            "error.json",
                            &state
                                .debug
                                .project_payload_verbatim(json!({
                                    "object": "routecodex.v3.error_evidence",
                                    "stage": "error",
                                    "status": frame.status,
                                    "request_id": request_id,
                                    "endpoint": path,
                                    "node_trace": frame.node_trace.clone(),
                                    "error_chain": frame.error_chain.clone(),
                                    "observability": frame.observability.as_ref().map(project_v3_runtime_observability_debug),
                                })),
                            (frame.status >= 400).then_some(frame.status),
                        );
                    }
                    if let Some(response) = capture_v3_responses_direct_response(
                        &state,
                        &entry_protocol,
                        &path,
                        &request_id,
                        &mut frame,
                    ) {
                        return response;
                    }
                    if let Some(response) = record_v3_live_snapshot_projection(
                        &state,
                        &trace_scope,
                        snapshot_session_id.as_deref(),
                        frame.status,
                        &frame.node_trace,
                        "live_response",
                    ) {
                        return response;
                    }
                    let stream_console_finalizer =
                        emit_v3_direct_frame_console_lines(&console_context, &frame, started_at);
                    return responses_direct_output_response_with_console(
                        frame,
                        stream_console_finalizer,
                        Duration::from_millis(state.server.http_sse_keepalive_ms),
                    );
                }
                V3ResponsesDirectServerOutcome::RelayOutput(mut relay_output) => {
                    prepend_v3_protocol_plan_trace_to_responses_relay_output(
                        &mut relay_output,
                        &handoff.node_trace,
                    );
                    merge_v3_direct_handoff_provider_failure_events(
                        &mut relay_output,
                        handoff.provider_failure_events,
                    );
                    return finalize_v3_responses_relay_server_output(
                        &state,
                        &trace_scope,
                        snapshot_session_id.as_deref(),
                        &entry_protocol,
                        &path,
                        &request_id,
                        relay_output,
                        &console_context,
                        started_at,
                        request_console_project_path.as_deref(),
                        &console_payload,
                    );
                }
            }
        }
        return finalize_v3_responses_relay_server_output(
            &state,
            &trace_scope,
            snapshot_session_id.as_deref(),
            &entry_protocol,
            &path,
            &request_id,
            output,
            &console_context,
            started_at,
            request_console_project_path.as_deref(),
            &console_payload,
        );
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        let raw_request_payload = payload.clone();
        let console_payload = payload.clone();
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_identity,
            &request_headers,
            &console_payload,
        );
        let provider_failure_event_sink = build_v3_provider_failure_event_sink(&console_context);
        let route_selection_event_sink = build_v3_route_selection_event_sink(&console_context);
        let outcome = execute_responses_direct_server_outcome(
            &state,
            &request_headers,
            method,
            path.clone(),
            request_id.clone(),
            execution_id,
            payload,
            responses_protocol_plan.as_ref(),
            None,
            Some(provider_failure_event_sink.clone()),
            Some(route_selection_event_sink.clone()),
        )
        .await;
        match outcome {
            V3ResponsesDirectServerOutcome::DirectFrame(mut frame) => {
                // 可观测性：direct 分支对齐 relay——status>=400 或 provider 失败时
                // 无条件落盘 request.json + error.json（绕过 codex_samples 开关），
                // 否则 direct 错误只在内存 trace，无法事后诊断。
                let has_provider_failure = frame.observability.as_ref().is_some_and(
                    |observability| !observability.provider_failure_events.is_empty(),
                );
                if frame.status >= 400 || has_provider_failure {
                    let _ = persist_v3_error_evidence_payload(
                        &state,
                        &entry_protocol,
                        &path,
                        &request_id,
                        "request.json",
                        &state
                            .debug
                            .project_payload_verbatim(raw_request_payload.clone()),
                        (frame.status >= 400).then_some(frame.status),
                    );
                    let _ = persist_v3_error_evidence_payload(
                        &state,
                        &entry_protocol,
                        &path,
                        &request_id,
                        "error.json",
                        &state
                            .debug
                            .project_payload_verbatim(json!({
                                "object": "routecodex.v3.error_evidence",
                                "stage": "error",
                                "status": frame.status,
                                "request_id": request_id,
                                "endpoint": path,
                                "node_trace": frame.node_trace.clone(),
                                "error_chain": frame.error_chain.clone(),
                                "observability": frame.observability.as_ref().map(project_v3_runtime_observability_debug),
                            })),
                        (frame.status >= 400).then_some(frame.status),
                    );
                }
                if let Some(response) = capture_v3_responses_direct_response(
                    &state,
                    &entry_protocol,
                    &path,
                    &request_id,
                    &mut frame,
                ) {
                    return response;
                }
                if let Some(response) = record_v3_live_snapshot_projection(
                    &state,
                    &trace_scope,
                    snapshot_session_id.as_deref(),
                    frame.status,
                    &frame.node_trace,
                    "live_response",
                ) {
                    return response;
                }
                let console_context = build_v3_console_emission_context(
                    &state,
                    &entry_protocol,
                    &path,
                    &request_identity,
                    &request_headers,
                    &console_payload,
                );
                let stream_console_finalizer =
                    emit_v3_direct_frame_console_lines(&console_context, &frame, started_at);
                responses_direct_output_response_with_console(
                    frame,
                    stream_console_finalizer,
                    Duration::from_millis(state.server.http_sse_keepalive_ms),
                )
            }
            V3ResponsesDirectServerOutcome::RelayOutput(output) => {
                finalize_v3_responses_relay_server_output(
                    &state,
                    &trace_scope,
                    snapshot_session_id.as_deref(),
                    &entry_protocol,
                    &path,
                    &request_id,
                    output,
                    &console_context,
                    started_at,
                    request_console_project_path.as_deref(),
                    &raw_request_payload,
                )
            }
        }
    } else if execution_mode == V3EntryProtocolExecutionMode::PendingNotImplemented {
        let pending_not_implemented = execution_mode.as_str();
        let Some(pending_owner) = pending_owner_symbol else {
            return error_output_response_for_server_with_project_path(
                &state.server,
                &path,
                &request_id,
                project_http_input_error(
                    V3HttpBoundaryErrorKind::EndpointNotEnabled,
                    format!(
                        "entry protocol {entry_protocol} pending binding lacks explicit pending owner"
                    ),
                ),
                request_console_project_path.as_deref(),
            );
        };
        let output = execute_v3_foundation_pending_runtime(
            V3FoundationRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                execution_id,
                method,
                path,
                payload,
            },
            &state.debug,
        );
        if let Some(response) = record_v3_live_snapshot_projection(
            &state,
            &trace_scope,
            snapshot_session_id.as_deref(),
            output.status,
            &output.node_trace,
            "live_response",
        ) {
            return response;
        }
        pending_binding_output_response(
            output,
            &entry_protocol,
            pending_not_implemented,
            &pending_owner,
        )
    } else {
        error_output_response_for_server_with_project_path(
            &state.server,
            &path,
            &request_id,
            project_http_input_error(
                V3HttpBoundaryErrorKind::EndpointNotEnabled,
                format!(
                    "entry protocol {entry_protocol} is bound to unsupported execution mode {}",
                    execution_mode.as_str()
                ),
            ),
            request_console_project_path.as_deref(),
        )
    }
}

pub(crate) fn is_provider_request_dry_run(headers: &HeaderMap) -> bool {
    headers
        .get("x-routecodex-dry-run")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("provider-request"))
}

fn resolve_v3_dry_run_target_label(state: &V3ListenerState) -> String {
    state
        .manifest
        .providers
        .values()
        .find_map(|provider| {
            let auth_alias = provider.auth.entries.first()?.alias.as_str();
            let model = provider.models.get(&provider.default_model)?;
            Some(format!(
                "{}[{}].{}",
                provider.id, auth_alias, model.wire_name
            ))
        })
        .unwrap_or_else(|| "-".to_string())
}

pub(crate) fn merge_v3_protocol_plan_trace(
    mut plan_trace: Vec<&'static str>,
    runtime_trace: Vec<&'static str>,
) -> Vec<&'static str> {
    plan_trace.extend(runtime_trace);
    plan_trace
}

pub(crate) fn prepend_v3_protocol_plan_trace_to_foundation_output(
    output: &mut V3FoundationRuntimeOutput,
    plan_trace: &[&'static str],
) {
    let merged = merge_v3_protocol_plan_trace(plan_trace.to_vec(), output.node_trace.clone());
    output.node_trace = merged.clone();
    if let Some(dry_run) = output
        .body
        .get_mut("dry_run")
        .and_then(Value::as_object_mut)
    {
        dry_run.insert("node_ids".to_string(), json!(merged));
    }
}

pub(crate) fn prepend_v3_protocol_plan_trace_to_responses_relay_output(
    output: &mut V3ResponsesRelayRuntimeOutput,
    plan_trace: &[&'static str],
) {
    output.node_trace =
        merge_v3_protocol_plan_trace(plan_trace.to_vec(), output.node_trace.clone());
}

pub(crate) fn prepend_v3_relay_handoff_trace_to_direct_frame(
    frame: &mut V3Server16HttpFrame,
    relay_trace: &[&'static str],
) {
    frame.node_trace = merge_v3_protocol_plan_trace(relay_trace.to_vec(), frame.node_trace.clone());
}

pub(crate) fn merge_v3_direct_handoff_provider_failure_events(
    output: &mut V3ResponsesRelayRuntimeOutput,
    direct_events: Vec<V3RuntimeProviderFailureObservation>,
) {
    if direct_events.is_empty() {
        return;
    }
    let observability = output.observability.get_or_insert_with(Default::default);
    let mut merged = direct_events;
    merged.append(&mut observability.provider_failure_events);
    observability.provider_failure_events = merged;
}

pub(crate) fn merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
    frame: &mut V3Server16HttpFrame,
    relay_events: Vec<V3RuntimeProviderFailureObservation>,
) {
    if relay_events.is_empty() {
        return;
    }
    let observability = frame.observability.get_or_insert_with(Default::default);
    let mut merged = relay_events;
    merged.append(&mut observability.provider_failure_events);
    observability.provider_failure_events = merged;
}

pub(crate) fn allocate_v3_console_request_id(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<String, Box<Response<Body>>> {
    allocate_v3_console_request_identity(state, endpoint, payload)
        .map(|identity| identity.request_id)
}

pub(crate) fn allocate_v3_console_request_identity(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<V3AllocatedRequestIdentity, Box<Response<Body>>> {
    next_v3_console_request_identity(state, endpoint, payload).map_err(|message| {
        let output = project_v3_debug_failure(
            "V3RequestIdCounter01Allocated",
            V3DebugError::MalformedFixture(message),
        );
        emit_v3_error_console_line_for_state(
            state,
            endpoint,
            "request-id-unavailable",
            output.status,
            &output.error_chain,
            Some(&output.body),
            None,
        );
        Box::new(foundation_output_response(output))
    })
}

pub(crate) fn next_v3_console_request_identity(
    state: &V3ListenerState,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<V3AllocatedRequestIdentity, String> {
    let entry = format_v3_request_id_entry(endpoint);
    let provider = "router";
    let model = format_v3_request_id_token(
        payload
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
    );
    state
        .request_counter
        .lock()
        .map_err(|_| "V3 request id counter lock is poisoned".to_string())?
        .next_request_identity(&entry, provider, &model)
}

pub(crate) fn format_v3_request_id_entry(endpoint: &str) -> String {
    let raw = endpoint.to_ascii_lowercase();
    if raw.contains("/v1/responses") {
        "openai-responses".to_string()
    } else if raw.contains("/v1/messages") || raw.contains("/anthropic") {
        "anthropic-messages".to_string()
    } else {
        "openai-chat".to_string()
    }
}

pub(crate) fn format_v3_request_id_token(value: &str) -> String {
    let mut token: String = value
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
        .collect();
    if token
        .chars()
        .next()
        .is_some_and(|character| !character.is_ascii_alphabetic())
    {
        token.remove(0);
    }
    if token.is_empty() {
        "unknown".to_string()
    } else {
        token
    }
}
