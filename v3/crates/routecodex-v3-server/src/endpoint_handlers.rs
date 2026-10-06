use crate::*;
use axum::body::Body;
use axum::http::{HeaderMap, Response};
use futures_util::FutureExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) async fn pending_endpoint_after_responses_admission_inner(
    state: Arc<V3ListenerState>,
    front_connection_identity: Option<V3FrontConnectionIdentity>,
    request_headers: HeaderMap,
    method: String,
    path: String,
    started_at: Instant,
    entry_protocol: String,
    mut execution_mode: V3EntryProtocolExecutionMode,
    pending_owner_symbol: Option<String>,
    request_purpose: V3RequestPurpose,
    payload: Value,
) -> Response<Body> {
    let client_keepalive_interval = Some(Duration::from_millis(state.server.http_sse_keepalive_ms));
    let request_identity = match allocate_v3_console_request_identity(&state, &path, Some(&payload))
    {
        Ok(request_identity) => request_identity,
        Err(response) => return *response,
    };
    let request_id = request_identity.request_id.clone();
    // One allocation: every terminal branch records this same request identity.
    let terminal_evidence = V3ProviderTerminalEvidence {
        entry_protocol: &entry_protocol,
        endpoint: &path,
        request_id: &request_id,
    };
    let toolreason_observation_session_id =
        resolve_v3_console_log_identity_from_parts(&request_headers, &payload, &request_id)
            .session_id;
    let responses_entry_facts =
        (entry_protocol == "responses").then(|| V3ResponsesEntryFacts::project(&payload));
    let requested_stream = v3_request_wants_sse(&request_headers, &payload);
    let (execution_id, trace_scope) =
        match crate::client_transport_observation::start_v3_client_trace(
            &state,
            front_connection_identity,
            &request_id,
            toolreason_observation_session_id.clone(),
        ) {
            Ok(trace) => trace,
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
            "request_purpose": if request_purpose.is_compaction() {
                "compaction"
            } else {
                "conversation"
            },
            "server_id": state.server.id.clone(),
            "front_connection_identity": front_connection_identity.map(|identity| identity.0)
        })),
    ) {
        return foundation_output_response(project_v3_debug_failure(
            "V3Server03HttpRequestRaw",
            error,
        ));
    }
    let provider_failure_session_scope =
        match get_failure_session_scope(&state.server, &request_headers, &request_id) {
            Ok(scope) => scope,
            Err(message) => {
                return error_output_response_for_server_with_project_path(
                    &state.server,
                    &path,
                    &request_id,
                    project_v3_server_runtime_failure(
                        "V3Server03HttpRequestRaw",
                        "provider_transport_handoff_scope_incomplete",
                        message,
                        598,
                    ),
                    None,
                );
            }
        };
    let provider_failure_session_scope = match provider_failure_session_scope
        .with_transport_handoff_scope(
            request_identity.pipeline_id.clone(),
            state.server.port,
            state.front_transport_broker.generation(),
        ) {
        Ok(scope) => scope,
        Err(message) => {
            return error_output_response_for_server_with_project_path(
                &state.server,
                &path,
                &request_id,
                project_v3_server_runtime_failure(
                    "V3Server03HttpRequestRaw",
                    "provider_transport_handoff_scope_incomplete",
                    message,
                    598,
                ),
                None,
            );
        }
    };
    let payload = match routecodex_v3_runtime::operation_runner::execute_v3_operation_runner_request_capture_client_json(payload) {
        Ok(captured) => captured,
        Err(error) => {
            return error_output_response_for_server_with_project_path(
                &state.server,
                &path,
                &request_id,
                project_v3_server_runtime_failure(
                    "V3OperationRunnerCaptureClientJson",
                    "operation_runner_capture_client_json_failed",
                    error.to_string(),
                    598,
                ),
                None,
            );
        }
    };
    let responses_protocol_plan = if entry_protocol == "responses"
        && responses_entry_facts
            .as_ref()
            .is_some_and(responses_entry_facts_allow_fresh_protocol_plan)
    {
        let raw = build_v3_server_03_http_request_raw_with_purpose_and_scope(
            state.server.id.clone(),
            provider_failure_session_scope.clone(),
            request_id.clone(),
            execution_id.clone(),
            method.clone(),
            path.clone(),
            request_purpose,
            Some(state.server.port),
            Some(request_identity.pipeline_id.clone()),
            payload.clone(),
        );
        let plan = match plan_v3_responses_protocol_execution_with_provider_health(
            &state.manifest,
            raw,
            state.provider_health.runtime_health(),
            current_epoch_ms(),
        ) {
            Ok(plan) => plan,
            Err(failure) => {
                let node_trace = failure.node_trace.clone();
                let projected = project_v3_protocol_execution_plan_failure(failure);
                if projected.pool_exhausted {
                    // A selection-time pool exhaustion is a provider terminal:
                    // no candidate was admitted, so there is no upstream
                    // response to witness and the client boundary is the
                    // transport break. The Error06 body stays provider-private
                    // evidence on disk, never a client payload.
                    persist_v3_projected_terminal_error_evidence(
                        &state,
                        &entry_protocol,
                        &path,
                        &request_id,
                        &payload,
                        &node_trace,
                        &projected,
                    );
                    return provider_terminal_response(
                        &state,
                        front_connection_identity,
                        routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse,
                        requested_stream,
                        terminal_evidence,
                    );
                }
                let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
                return responses_direct_output_response(
                    project_v3_responses_error_frame_for_request_if_sse(
                        frame,
                        &request_headers,
                        Some(&payload),
                    ),
                    client_keepalive_interval,
                );
            }
        };
        execution_mode = match plan.decision.mode {
            V3Execution11ProtocolDecisionMode::SameProtocolDirect => {
                V3EntryProtocolExecutionMode::Direct
            }
            V3Execution11ProtocolDecisionMode::HubRelay => V3EntryProtocolExecutionMode::Relay,
        };
        let metadata_plan = V3MetadataCenterExecutionPlan::new(
            request_id.clone(),
            request_identity.pipeline_id.clone(),
            state.server.id.clone(),
            state.server.port,
            provider_failure_session_scope.session_id().to_string(),
            v3_request_wants_sse(&request_headers, &payload),
            plan,
        );
        Some(metadata_plan)
    } else {
        None
    };
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
                .boxed()
                .await
            }
            None => {
                execute_v3_responses_direct_dry_run_runtime(fixture, &state.manifest, &state.debug)
                    .boxed()
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
        if v3_codex_sample_scope_allows(&state, execution_mode) {
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
        let server_tool_scope = match build_responses_relay_server_tool_scope(
            &request_headers,
            Some(&payload),
            &request_id,
            &state.server,
            &path,
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
        let output =
            match execute_v3_responses_relay_dry_run_orchestration_outcome_with_server_tool_state(
                &state.manifest,
                V3ResponsesRelayRuntimeInput {
                    server_id: state.server.id.clone(),
                    failure_session_scope: provider_failure_session_scope.clone(),
                    request_id: request_id.clone(),
                    payload: payload.clone(),
                },
                &state.responses_relay_server_tool_state,
                server_tool_scope,
            )
            .boxed()
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
                    let mut output =
                        execute_v3_responses_direct_dry_run_runtime_with_initial_target(
                            fixture,
                            &state.manifest,
                            &state.debug,
                            &handoff.plan,
                        )
                        .boxed()
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
                toolreason_observation_session_id: Some(toolreason_observation_session_id.clone()),
                payload: payload.clone(),
            },
            client_headers,
        )
        .boxed()
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
        return Box::pin(execute_v3_openai_chat_direct_server_outcome(
            &state,
            front_connection_identity,
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
            request_purpose,
        ))
        .await;
    }
    if entry_protocol == "openai_chat" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let console_payload = payload.clone();
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_identity,
            &request_headers,
            &console_payload,
        );
        let output =
            match Box::pin(execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_execution_mode(
                &state.manifest,
                V3OpenAiChatRelayRuntimeInput {
                    server_id: state.server.id.clone(),
                    failure_session_scope: provider_failure_session_scope.clone(),
                    request_id: request_id.clone(),
                    payload: payload.clone(),
                },
                state.provider_health.runtime_health(),
                V3HubExecutionMode::Relay,
            ))
            .await
            {
                Ok(output) => output,
                Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
            };
        if let Some(disposition) = output.terminal_disposition.clone() {
            project_v3_relay_terminal_diagnostics(
                &state,
                &trace_scope,
                V3TerminalErrorEvidence {
                    entry_protocol: &entry_protocol,
                    endpoint: &path,
                    request_id: &request_id,
                    raw_request_payload: &payload,
                    status: output.status,
                    node_trace: &output.node_trace,
                    error_chain: output.error_chain.as_deref(),
                    observability: output.observability.as_ref(),
                },
                snapshot_session_id.as_deref(),
                request_console_project_path.as_deref(),
                openai_chat_error_body_for_console(&output.client_body),
            );
            return provider_terminal_response(
                &state,
                front_connection_identity,
                disposition,
                requested_stream,
                terminal_evidence,
            );
        }
        emit_relay_error_chain_if_any(
            &state,
            &trace_scope,
            &entry_protocol,
            &path,
            &request_id,
            snapshot_session_id.as_deref(),
            output.status,
            output.error_chain.as_deref(),
            openai_chat_error_body_for_console(&output.client_body),
            request_console_project_path.as_deref(),
        );
        let mut output = output;
        if let Some(response) = capture_v3_relay_provider_snapshots(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &mut output.provider_snapshots,
        ) {
            return response;
        }
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
        let stream_console_finalizer = match (
            output.stream_observation.clone(),
            output.observability.clone(),
        ) {
            (Some(stream_observation), Some(observability)) => Some(V3SseConsoleFinalizer {
                context: console_context.clone(),
                status: output.status,
                node_trace: output.node_trace.clone(),
                observability,
                stream_observation,
                started_at,
            }),
            _ => None,
        };
        if let Some(observability) = output.observability.as_ref() {
            emit_v3_observability_console_lines(
                &console_context,
                output.status,
                &output.node_trace,
                observability,
                started_at,
                output.stream_observation.is_none(),
            );
        }
        return openai_chat_relay_output_response(
            output,
            stream_console_finalizer,
            Duration::from_millis(state.server.http_sse_keepalive_ms),
            requested_stream,
        );
    }
    if entry_protocol == "anthropic" && execution_mode == V3EntryProtocolExecutionMode::Relay {
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
        let output = match Box::pin(execute_v3_anthropic_relay_runtime_with_default_transport_client_headers_provider_health(
            &state.manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                failure_session_scope: provider_failure_session_scope.clone(),
                request_id: request_id.clone(),
                toolreason_observation_session_id: Some(
                    toolreason_observation_session_id.clone(),
                ),
                payload: payload.clone(),
            },
            client_headers,
            state.provider_health.runtime_health(),
        ))
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_anthropic_relay_runtime_failure(error),
        };
        if let Some(disposition) = output.terminal_disposition.clone() {
            project_v3_relay_terminal_diagnostics(
                &state,
                &trace_scope,
                V3TerminalErrorEvidence {
                    entry_protocol: &entry_protocol,
                    endpoint: &path,
                    request_id: &request_id,
                    raw_request_payload: &payload,
                    status: output.status,
                    node_trace: &output.node_trace,
                    error_chain: output.error_chain.as_deref(),
                    observability: output.observability.as_ref(),
                },
                snapshot_session_id.as_deref(),
                request_console_project_path.as_deref(),
                Some(&output.client_response),
            );
            return provider_terminal_response(
                &state,
                front_connection_identity,
                disposition,
                requested_stream,
                terminal_evidence,
            );
        }
        emit_relay_error_chain_if_any(
            &state,
            &trace_scope,
            &entry_protocol,
            &path,
            &request_id,
            snapshot_session_id.as_deref(),
            output.status,
            output.error_chain.as_deref(),
            Some(&output.client_response),
            request_console_project_path.as_deref(),
        );
        let mut output = output;
        if let Some(response) = capture_v3_relay_provider_snapshots(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &mut output.provider_snapshots,
        ) {
            return response;
        }
        if let Some(response) = capture_v3_anthropic_relay_response(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &output,
        ) {
            return response;
        }
        let console_payload = payload.clone();
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_identity,
            &request_headers,
            &console_payload,
        );
        if let Some(observability) = output.observability.as_mut() {
            if let Err(error) = merge_v3_runtime_stream_observation(
                observability,
                output.stream_observation.as_ref(),
            ) {
                emit_v3_runtime_observability_contract_failure(
                    &console_context,
                    observability,
                    error,
                );
            }
        }
        if let Err(error) =
            emit_v3_toolreason_console_line(&console_context, output.stream_observation.as_ref())
        {
            emit_v3_runtime_observability_contract_failure(
                &console_context,
                output
                    .observability
                    .as_ref()
                    .unwrap_or(&V3RuntimeObservability::default()),
                error,
            );
        }
        if let Some(observability) = output.observability.as_ref() {
            let mut console_observability = observability.clone();
            if let Err(error) = merge_v3_runtime_stream_observation(
                &mut console_observability,
                output.stream_observation.as_ref(),
            ) {
                emit_v3_runtime_observability_contract_failure(
                    &console_context,
                    &console_observability,
                    error,
                );
            } else {
                emit_v3_observability_console_lines(
                    &console_context,
                    output.status,
                    &output.node_trace,
                    &console_observability,
                    started_at,
                    true,
                );
            }
        }
        return anthropic_relay_output_response(output, requested_stream);
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
        .boxed()
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_gemini_relay_runtime_failure(error),
        };
        if let Some(disposition) = output.terminal_disposition.clone() {
            project_v3_relay_terminal_diagnostics(
                &state,
                &trace_scope,
                V3TerminalErrorEvidence {
                    entry_protocol: &entry_protocol,
                    endpoint: &path,
                    request_id: &request_id,
                    raw_request_payload: &payload,
                    status: output.status,
                    node_trace: &output.node_trace,
                    error_chain: output.error_chain.as_deref(),
                    observability: output.observability.as_ref(),
                },
                snapshot_session_id.as_deref(),
                request_console_project_path.as_deref(),
                gemini_error_body_for_console(&output.client_body),
            );
            return provider_terminal_response(
                &state,
                front_connection_identity,
                disposition,
                requested_stream,
                terminal_evidence,
            );
        }
        emit_relay_error_chain_if_any(
            &state,
            &trace_scope,
            &entry_protocol,
            &path,
            &request_id,
            snapshot_session_id.as_deref(),
            output.status,
            output.error_chain.as_deref(),
            gemini_error_body_for_console(&output.client_body),
            request_console_project_path.as_deref(),
        );
        let console_payload = payload.clone();
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_identity,
            &request_headers,
            &console_payload,
        );
        let stream_console_finalizer = match (
            output.stream_observation.clone(),
            output.observability.clone(),
        ) {
            (Some(stream_observation), Some(observability)) => Some(V3SseConsoleFinalizer {
                context: console_context.clone(),
                status: output.status,
                node_trace: output.node_trace.clone(),
                observability,
                stream_observation,
                started_at,
            }),
            _ => None,
        };
        if let Some(observability) = output.observability.as_ref() {
            emit_v3_observability_console_lines(
                &console_context,
                output.status,
                &output.node_trace,
                observability,
                started_at,
                output.stream_observation.is_none(),
            );
        }
        return gemini_relay_output_response(
            output,
            stream_console_finalizer,
            Duration::from_millis(state.server.http_sse_keepalive_ms),
            requested_stream,
        );
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let server_tool_scope = match build_responses_relay_server_tool_scope(
            &request_headers,
            Some(&payload),
            &request_id,
            &state.server,
            &path,
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
                Some(plan) => match execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    &state.responses_relay_server_tool_state,
                    server_tool_scope.clone(),
                    V3ResponsesRelayProviderSnapshotCapture::new(
                        capture_provider_request,
                        capture_provider_response,
                    ),
                    Some(provider_failure_event_sink.clone()),
                    Some(route_selection_event_sink.clone()),
                    Some(plan.decision.target.clone()),
                    Some(plan.expanded.clone()),
                    BTreeSet::new(),
                    None,
                    None,
                    plan.relay_runtime_seeds(),
                    V3RelayEntryOrigin::ClientEntry,
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
                    Err(error) => project_v3_responses_relay_runtime_failure(error, None),
                },
                None => match execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    &state.responses_relay_server_tool_state,
                    server_tool_scope.clone(),
                    V3ResponsesRelayProviderSnapshotCapture::new(
                        capture_provider_request,
                        capture_provider_response,
                    ),
                    Some(provider_failure_event_sink.clone()),
                    Some(route_selection_event_sink.clone()),
                    None,
                    None,
                    BTreeSet::new(),
                    None,
                    None,
                    V3ResponsesRelayRuntimeSeeds::default(),
                    V3RelayEntryOrigin::ClientEntry,
                )
                .await
                {
                    Ok(output) => output,
                    Err(error) => project_v3_responses_relay_runtime_failure(error, None),
                },
            }
        } else {
            match responses_protocol_plan.as_ref() {
                Some(plan) => match execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    &state.responses_relay_server_tool_state,
                    server_tool_scope.clone(),
                    V3ResponsesRelayProviderSnapshotCapture::new(false, false),
                    Some(provider_failure_event_sink.clone()),
                    Some(route_selection_event_sink.clone()),
                    Some(plan.decision.target.clone()),
                    Some(plan.expanded.clone()),
                    BTreeSet::new(),
                    None,
                    None,
                    plan.relay_runtime_seeds(),
                    V3RelayEntryOrigin::ClientEntry,
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
                    Err(error) => project_v3_responses_relay_runtime_failure(error, None),
                },
                None => match execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state(
                    &state.manifest,
                    runtime_input,
                    &state.provider_health,
                    &state.responses_relay_server_tool_state,
                    server_tool_scope,
                    V3ResponsesRelayProviderSnapshotCapture::new(false, false),
                    Some(provider_failure_event_sink.clone()),
                    Some(route_selection_event_sink.clone()),
                    None,
                    None,
                    BTreeSet::new(),
                    None,
                    None,
                    V3ResponsesRelayRuntimeSeeds::default(),
                    V3RelayEntryOrigin::ClientEntry,
                )
                .await
                {
                    Ok(output) => output,
                    Err(error) => project_v3_responses_relay_runtime_failure(error, None),
                },
            }
        };
        if let Some(disposition) = output.terminal_disposition.take() {
            // A provider terminal disposition ends the client transport without
            // a client payload, so this path never reaches the relay closeout
            // below. The status, node trace and Error chain are still real typed
            // facts: record the request-bound evidence and project the chain
            // first, otherwise a request that really failed keeps an
            // observability row whose every Error node reads "not_reached" and
            // leaves no artifact on disk.
            project_v3_relay_terminal_diagnostics(
                &state,
                &trace_scope,
                V3TerminalErrorEvidence {
                    entry_protocol: &entry_protocol,
                    endpoint: &path,
                    request_id: &request_id,
                    raw_request_payload: &console_payload,
                    status: output.status,
                    node_trace: &output.node_trace,
                    error_chain: output.error_chain.as_deref(),
                    observability: output.observability.as_ref(),
                },
                snapshot_session_id.as_deref(),
                request_console_project_path.as_deref(),
                relay_error_body_for_console(&output.client_body),
            );
            return provider_terminal_response(
                &state,
                front_connection_identity,
                disposition,
                requested_stream,
                terminal_evidence,
            );
        }
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
            let outcome = Box::pin(execute_responses_direct_server_outcome(
                &state,
                &request_headers,
                method,
                path.clone(),
                request_id.clone(),
                Some(request_identity.pipeline_id.clone()),
                execution_id,
                handoff.request_payload.clone(),
                Some(relay_entry(&handoff.plan, handoff.request_entry_origin)),
                Some(handoff.observability_accumulator),
                Some(handoff.request_execution_control),
                Some(provider_failure_event_sink.clone()),
                Some(route_selection_event_sink.clone()),
                request_purpose,
            ))
            .await;
            match outcome {
                V3ResponsesDirectServerOutcome::ProviderTerminal(disposition) => {
                    return provider_terminal_response(
                        &state,
                        front_connection_identity,
                        disposition,
                        requested_stream,
                        terminal_evidence,
                    );
                }
                V3ResponsesDirectServerOutcome::DirectFrame(mut frame) => {
                    prepend_v3_relay_handoff_trace_to_direct_frame(&mut frame, &handoff.node_trace);
                    merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
                        &mut frame,
                        handoff.provider_failure_events,
                    );
                    // Recovered provider failures are not terminal client errors; only the
                    // Error06/status truth may create error.json after a successful handoff.
                    if frame.status >= 400 || !frame.error_chain.is_empty() {
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
                    let frame =
                        project_v3_responses_direct_stream_error_frame_if_requested(frame, true);
                    return responses_direct_output_response_with_console(
                        frame,
                        stream_console_finalizer,
                        client_keepalive_interval,
                    );
                }
                V3ResponsesDirectServerOutcome::RelayOutput(mut relay_output) => {
                    if let Some(disposition) = relay_output.terminal_disposition.take() {
                        // Same entry, same defect as the branch below: a
                        // provider terminal disposition bypasses the relay
                        // closeout, so the real typed facts and the on-disk
                        // evidence have to be recorded here as well.
                        project_v3_relay_terminal_diagnostics(
                            &state,
                            &trace_scope,
                            V3TerminalErrorEvidence {
                                entry_protocol: &entry_protocol,
                                endpoint: &path,
                                request_id: &request_id,
                                raw_request_payload: &console_payload,
                                status: relay_output.status,
                                node_trace: &relay_output.node_trace,
                                error_chain: relay_output.error_chain.as_deref(),
                                observability: relay_output.observability.as_ref(),
                            },
                            snapshot_session_id.as_deref(),
                            request_console_project_path.as_deref(),
                            relay_error_body_for_console(&relay_output.client_body),
                        );
                        return provider_terminal_response(
                            &state,
                            front_connection_identity,
                            disposition,
                            requested_stream,
                            terminal_evidence,
                        );
                    }
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
                        client_keepalive_interval,
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
            client_keepalive_interval,
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
        let outcome = Box::pin(execute_responses_direct_server_outcome(
            &state,
            &request_headers,
            method,
            path.clone(),
            request_id.clone(),
            Some(request_identity.pipeline_id.clone()),
            execution_id,
            payload,
            responses_protocol_plan
                .as_ref()
                .map(|plan| client_entry(plan.protocol_plan())),
            None,
            None,
            Some(provider_failure_event_sink.clone()),
            Some(route_selection_event_sink.clone()),
            request_purpose,
        ))
        .await;
        match outcome {
            V3ResponsesDirectServerOutcome::ProviderTerminal(disposition) => {
                provider_terminal_response(
                    &state,
                    front_connection_identity,
                    disposition,
                    requested_stream,
                    terminal_evidence,
                )
            }
            V3ResponsesDirectServerOutcome::DirectFrame(mut frame) => {
                // Recovered provider attempts are observability events, not a terminal
                // client error. Only status/Error06 truth creates error.json.
                if frame.status >= 400 || !frame.error_chain.is_empty() {
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
                if matches!(&frame.body, V3Server16Body::Sse(_)) {
                    let body =
                        std::mem::replace(&mut frame.body, V3Server16Body::Bytes(Vec::new()));
                    let V3Server16Body::Sse(stream) = body else {
                        unreachable!("matched live Direct SSE body")
                    };
                    frame.body = V3Server16Body::Sse(wrap_v3_live_sse_dump_stream(
                        stream,
                        state.sse_dump_enabled,
                        state.server.port,
                        &path,
                        &request_id,
                    ));
                } else if matches!(&frame.body, V3Server16Body::CommittedSse(_)) {
                    let body =
                        std::mem::replace(&mut frame.body, V3Server16Body::Bytes(Vec::new()));
                    let V3Server16Body::CommittedSse(stream) = body else {
                        unreachable!("matched committed Direct SSE body")
                    };
                    frame.body = V3Server16Body::CommittedSse(wrap_v3_committed_sse_dump_stream(
                        stream,
                        state.sse_dump_enabled,
                        state.server.port,
                        &path,
                        &request_id,
                    ));
                }
                responses_direct_output_response_with_console(
                    frame,
                    stream_console_finalizer,
                    client_keepalive_interval,
                )
            }
            V3ResponsesDirectServerOutcome::RelayOutput(output) => {
                if let Some(disposition) = output.terminal_disposition.clone() {
                    // Third and last Responses terminal-disposition site: same
                    // entry, same defect, so the real typed facts and the
                    // on-disk evidence are recorded before the client transport
                    // is broken without a payload.
                    project_v3_relay_terminal_diagnostics(
                        &state,
                        &trace_scope,
                        V3TerminalErrorEvidence {
                            entry_protocol: &entry_protocol,
                            endpoint: &path,
                            request_id: &request_id,
                            raw_request_payload: &raw_request_payload,
                            status: output.status,
                            node_trace: &output.node_trace,
                            error_chain: output.error_chain.as_deref(),
                            observability: output.observability.as_ref(),
                        },
                        snapshot_session_id.as_deref(),
                        request_console_project_path.as_deref(),
                        relay_error_body_for_console(&output.client_body),
                    );
                    return provider_terminal_response(
                        &state,
                        front_connection_identity,
                        disposition,
                        requested_stream,
                        terminal_evidence,
                    );
                }
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
                    client_keepalive_interval,
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
