use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::Response;
use axum::Json;
use routecodex_v3_runtime::{
    project_v3_debug_failure, project_v3_virtual_router_dry_run, project_v3_virtual_router_status,
    V3FoundationRuntimeInput, V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

pub(crate) async fn health(State(state): State<Arc<V3ListenerState>>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": 3,
        "manifest_version": state.manifest_version,
        "server_id": state.server.id,
        "bind": state.server.bind,
        "port": state.server.port,
    }))
}

pub(crate) async fn models_endpoint(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    json_response(
        200,
        build_v3_models_catalog(&state.manifest, &state.server.routing_group),
    )
}

pub(crate) async fn virtual_router_status(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response<Body> {
    if !remote.ip().is_loopback() {
        return json_response(
            403,
            json!({"error":{"message":"forbidden","code":"forbidden"}}),
        );
    }
    match project_v3_virtual_router_status(
        &state.manifest,
        &state.server.id,
        &state.provider_health.store(),
        current_epoch_ms(),
    ) {
        Ok(virtual_router) => json_response(
            200,
            json!({
                "ok": true,
                "serverId": state.server.id,
                "localPort": state.server.port,
                "routingPolicyGroup": state.server.routing_group,
                "virtualRouter": virtual_router
            }),
        ),
        Err(message) => json_response(
            500,
            json!({"error":{"message":message,"code":"virtual_router_diagnostics_failed"}}),
        ),
    }
}

pub(crate) async fn virtual_router_dry_run(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response<Body> {
    if !remote.ip().is_loopback() {
        return json_response(
            403,
            json!({"error":{"message":"forbidden","code":"forbidden"}}),
        );
    }
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => {
            return error_output_response_for_server(
                &state.server,
                "/_routecodex/diagnostics/virtual-router/dry-run",
                "pre-request",
                projected,
            );
        }
    };
    match project_v3_virtual_router_dry_run(
        &state.manifest,
        &state.server.id,
        &payload,
        &state.provider_health.store(),
        current_epoch_ms(),
    ) {
        Ok(diagnostics) => json_response(
            200,
            json!({
                "ok": true,
                "serverId": state.server.id,
                "localPort": state.server.port,
                "routingPolicyGroup": state.server.routing_group,
                "diagnostics": diagnostics
            }),
        ),
        Err(message) => json_response(
            500,
            json!({"error":{"message":message,"code":"virtual_router_dry_run_failed"}}),
        ),
    }
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) async fn pending_endpoint(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let request_headers = request.headers().clone();
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let started_at = Instant::now();
    let Some(binding) = state
        .manifest
        .hub_v1
        .as_ref()
        .and_then(|hub| hub.entry_protocol_binding_for_endpoint(&path))
    else {
        let request_id = match allocate_v3_console_request_id(&state, &path, None) {
            Ok(request_id) => request_id,
            Err(response) => return *response,
        };
        return error_output_response_for_server(
            &state.server,
            &path,
            &request_id,
            project_http_input_error(
                V3HttpBoundaryErrorKind::EndpointNotEnabled,
                format!("endpoint path {path} has no entry protocol binding"),
            ),
        );
    };
    let entry_protocol = binding.entry_protocol.clone();
    let mut execution_mode = binding.execution_mode;
    let pending_owner_symbol = binding.pending_owner_symbol.clone();
    if !state
        .server
        .endpoints
        .iter()
        .any(|declared| declared == &entry_protocol)
    {
        let request_id = match allocate_v3_console_request_id(&state, &path, None) {
            Ok(request_id) => request_id,
            Err(response) => return *response,
        };
        return error_output_response_for_server(
            &state.server,
            &path,
            &request_id,
            project_http_input_error(
                V3HttpBoundaryErrorKind::EndpointNotEnabled,
                format!(
                    "endpoint protocol {entry_protocol} is not enabled on server {}",
                    state.server.id
                ),
            ),
        );
    }
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => {
            let request_id = match allocate_v3_console_request_id(&state, &path, None) {
                Ok(request_id) => request_id,
                Err(response) => return *response,
            };
            let execution_id = state.debug.next_execution_id(&state.server.id);
            let trace_scope =
                match state
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
            let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
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
                    project_path: resolve_v3_console_project_path(&request_headers, &Value::Null)
                        .as_deref(),
                },
            ) {
                return response;
            }
            let frame = if entry_protocol == "responses" {
                project_v3_responses_error_frame_for_request_if_sse(frame, &request_headers, None)
            } else {
                frame
            };
            return responses_direct_output_response(frame);
        }
    };
    let request_id = match allocate_v3_console_request_id(&state, &path, Some(&payload)) {
        Ok(request_id) => request_id,
        Err(response) => return *response,
    };
    let execution_id = state.debug.next_execution_id(&state.server.id);
    let responses_previous_response_id = if entry_protocol == "responses" {
        payload
            .get("previous_response_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    } else {
        None
    };
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
    if entry_protocol == "responses" {
        let owner_resolution_context =
            match build_responses_previous_response_owner_resolution_context(
                &request_headers,
                &request_id,
                &state.server,
                &path,
                &payload,
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
                    return responses_direct_output_response(frame);
                }
            };
        match resolve_v3_responses_previous_response_owner_execution_mode_at_req03(
            &payload,
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
                return responses_direct_output_response(frame);
            }
        }
    }
    let mut responses_protocol_plan = None;
    if entry_protocol == "responses"
        && execution_mode == V3EntryProtocolExecutionMode::Direct
        && responses_previous_response_id.is_none()
    {
        let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        {
            Ok(duration) => duration.as_millis() as u64,
            Err(error) => {
                return foundation_output_response(project_v3_debug_failure(
                    "V3Execution11ProtocolDecision",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ));
            }
        };
        let raw_for_plan = build_v3_server_03_http_request_raw(
            state.server.id.clone(),
            request_id.clone(),
            execution_id.clone(),
            method.clone(),
            path.clone(),
            payload.clone(),
        );
        match plan_v3_responses_protocol_execution_with_provider_health(
            &state.manifest,
            raw_for_plan,
            state.provider_health.store(),
            now_epoch_ms,
        ) {
            Ok(plan) => {
                execution_mode = match plan.decision.mode {
                    V3Execution11ProtocolDecisionMode::SameProtocolDirect => {
                        V3EntryProtocolExecutionMode::Direct
                    }
                    V3Execution11ProtocolDecisionMode::HubRelay => {
                        V3EntryProtocolExecutionMode::Relay
                    }
                };
                responses_protocol_plan = Some(plan);
            }
            Err(failure) => {
                let mut frame = build_v3_server_16_http_frame_from_v3_error_06(
                    project_v3_protocol_execution_plan_failure(failure.clone()),
                );
                frame.node_trace = merge_v3_protocol_plan_trace(
                    failure.node_trace,
                    std::mem::take(&mut frame.node_trace),
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
                return responses_direct_output_response(frame);
            }
        }
    }
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
    if !(entry_protocol == "responses"
        && matches!(
            execution_mode,
            V3EntryProtocolExecutionMode::Direct | V3EntryProtocolExecutionMode::Relay
        ))
    {
        emit_v3_request_start_console_line(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &request_headers,
            &payload,
        );
    }
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
                "id": format!("dry_run_{request_id}"),
                "object": "response",
                "status": "completed",
                "output_text": "routecodex provider-request dry-run stopped before provider send"
            }),
        };
        let output = match responses_protocol_plan.as_ref() {
            Some(plan) => {
                execute_v3_responses_direct_dry_run_runtime(
                    fixture,
                    &state.manifest,
                    &state.debug,
                    V3ResponsesDirectDryRunExecutionEnv::new().with_initial_plan(plan),
                )
                .await
            }
            None => {
                execute_v3_responses_direct_dry_run_runtime(
                    fixture,
                    &state.manifest,
                    &state.debug,
                    V3ResponsesDirectDryRunExecutionEnv::new(),
                )
                .await
            }
        };
        let observability = build_v3_foundation_console_observability(&state, &output);
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &request_headers,
            &payload,
        );
        emit_v3_observability_console_lines(
            &console_context,
            output.status,
            &output.node_trace,
            &observability,
            started_at,
            true,
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
        && entry_protocol == "responses"
        && execution_mode == V3EntryProtocolExecutionMode::Relay
    {
        let continuation_scope = match build_responses_relay_local_continuation_scope(
            &request_headers,
            &request_id,
            &state.server,
            &path,
            &payload,
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
        let output = match responses_protocol_plan.as_ref() {
            Some(plan) => {
                let mut output = execute_v3_responses_relay_dry_run_runtime(
                    &state.manifest,
                    V3ResponsesRelayRuntimeInput {
                        server_id: state.server.id.clone(),
                        request_id: request_id.clone(),
                        payload: payload.clone(),
                    },
                    V3ResponsesRelayDryRunExecutionEnv::new()
                        .with_local_stopless_control(
                            &state.responses_relay_local_continuation,
                            &state.responses_relay_stopless_control,
                            continuation_scope,
                            now_epoch_ms,
                        )
                        .with_initial_target(plan.decision.target.clone()),
                )
                .await;
                prepend_v3_protocol_plan_trace_to_foundation_output(&mut output, &plan.node_trace);
                output
            }
            None => {
                execute_v3_responses_relay_dry_run_runtime(
                    &state.manifest,
                    V3ResponsesRelayRuntimeInput {
                        server_id: state.server.id.clone(),
                        request_id: request_id.clone(),
                        payload: payload.clone(),
                    },
                    V3ResponsesRelayDryRunExecutionEnv::new().with_local_stopless_control(
                        &state.responses_relay_local_continuation,
                        &state.responses_relay_stopless_control,
                        continuation_scope,
                        now_epoch_ms,
                    ),
                )
                .await
            }
        };
        let observability = build_v3_foundation_console_observability(&state, &output);
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &request_headers,
            &payload,
        );
        emit_v3_observability_console_lines(
            &console_context,
            output.status,
            &output.node_trace,
            &observability,
            started_at,
            true,
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
        let output = execute_v3_anthropic_relay_dry_run_runtime(
            &state.manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id: request_id.clone(),
                payload: payload.clone(),
            },
        )
        .await;
        let observability = build_v3_foundation_console_observability(&state, &output);
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &request_headers,
            &payload,
        );
        emit_v3_observability_console_lines(
            &console_context,
            output.status,
            &output.node_trace,
            &observability,
            started_at,
            true,
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
    if entry_protocol == "openai_chat" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output = match execute_v3_openai_chat_completions_request(
            &state.manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id: request_id.clone(),
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
        };
        if let Some(error_chain) = output.error_chain.as_deref() {
            if let Some(response) = record_and_emit_v3_error_projection(
                &state,
                &trace_scope,
                V3ErrorProjectionConsoleInput {
                    endpoint: &path,
                    request_id: &request_id,
                    status: output.status,
                    error_chain,
                    body: openai_chat_error_body_for_console(&output.client_body),
                    project_path: request_console_project_path.as_deref(),
                },
            ) {
                return response;
            }
        }
        return openai_chat_relay_output_response(output);
    }
    if entry_protocol == "anthropic" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let stream = payload.get("stream").and_then(serde_json::Value::as_bool) == Some(true);
        let output = match execute_v3_anthropic_messages_request(
            &state.manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id: request_id.clone(),
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_anthropic_relay_runtime_failure(error),
        };
        if let Some(error_chain) = output.error_chain.as_deref() {
            if let Some(response) = record_and_emit_v3_error_projection(
                &state,
                &trace_scope,
                V3ErrorProjectionConsoleInput {
                    endpoint: &path,
                    request_id: &request_id,
                    status: output.status,
                    error_chain,
                    body: Some(&output.client_response),
                    project_path: request_console_project_path.as_deref(),
                },
            ) {
                return response;
            }
        }
        return anthropic_relay_output_response(output, stream);
    }
    if entry_protocol == "gemini" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output = match execute_v3_gemini_generate_content_request(
            &state.manifest,
            V3GeminiRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id: request_id.clone(),
                endpoint_path: path.clone(),
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_gemini_relay_runtime_failure(error),
        };
        if let Some(error_chain) = output.error_chain.as_deref() {
            if let Some(response) = record_and_emit_v3_error_projection(
                &state,
                &trace_scope,
                V3ErrorProjectionConsoleInput {
                    endpoint: &path,
                    request_id: &request_id,
                    status: output.status,
                    error_chain,
                    body: gemini_error_body_for_console(&output.client_body),
                    project_path: request_console_project_path.as_deref(),
                },
            ) {
                return response;
            }
        }
        return gemini_relay_output_response(output);
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let continuation_scope = match build_responses_relay_local_continuation_scope(
            &request_headers,
            &request_id,
            &state.server,
            &path,
            &payload,
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
            request_id: request_id.clone(),
            payload,
        };
        let capture_provider_request = state
            .debug
            .should_capture_snapshot_stage("provider-request");
        let capture_provider_response = state
            .debug
            .should_capture_snapshot_stage("provider-response");
        let mut output = if capture_provider_request || capture_provider_response {
            let transport = V3LiveSnapResponsesTransport::with_default_transport();
            let snapshots = transport.snapshots();
            let capture = V3ResponsesRelayProviderSnapshotCapture::new(
                capture_provider_request,
                capture_provider_response,
            );
            let mut output = execute_responses_relay_runtime_for_http_request(
                &state,
                runtime_input,
                &transport,
                continuation_scope,
                now_epoch_ms,
                responses_protocol_plan.as_ref(),
            )
            .await;
            output.provider_snapshots =
                Some(snapshots.into_payload(capture.provider_request, capture.provider_response));
            output
        } else {
            let transport = V3ResponsesRelayDefaultTransport::default();
            execute_responses_relay_runtime_for_http_request(
                &state,
                runtime_input,
                &transport,
                continuation_scope,
                now_epoch_ms,
                responses_protocol_plan.as_ref(),
            )
            .await
        };
        if let Some(response) = capture_v3_responses_relay_provider_snapshots(
            &state,
            &entry_protocol,
            &path,
            &request_id,
            &output,
        ) {
            return response;
        }
        if let Some(response) = capture_v3_responses_relay_response(
            &state,
            &trace_scope,
            &entry_protocol,
            &path,
            &request_id,
            &mut output,
        ) {
            return response;
        }
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
        if let Some(error_chain) = output.error_chain.as_deref() {
            if let Some(response) = record_and_emit_v3_error_projection(
                &state,
                &trace_scope,
                V3ErrorProjectionConsoleInput {
                    endpoint: &path,
                    request_id: &request_id,
                    status: output.status,
                    error_chain,
                    body: relay_error_body_for_console(&output.client_body),
                    project_path: request_console_project_path.as_deref(),
                },
            ) {
                return response;
            }
        }
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_id,
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
        return responses_relay_output_response(output, stream_console_finalizer);
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        let console_payload = payload.clone();
        let frame = execute_responses_direct_server_frame(
            &state,
            &request_headers,
            method,
            path.clone(),
            request_id.clone(),
            execution_id,
            payload,
            responses_protocol_plan.as_ref(),
        )
        .await;
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
            &request_id,
            &request_headers,
            &console_payload,
        );
        let stream_console_finalizer =
            emit_v3_direct_frame_console_lines(&console_context, &frame, started_at);
        responses_direct_output_response_with_console(frame, stream_console_finalizer)
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

pub(crate) async fn debug_status(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.status() {
        Ok(status) => json_response(200, json!({ "debug": status })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugStatusProjected", error))
        }
    }
}

pub(crate) async fn debug_logs(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.logs() {
        Ok(logs) => json_response(200, json!({ "logs": logs })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugLogsProjected", error))
        }
    }
}

pub(crate) async fn debug_snapshots(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.snapshots() {
        Ok(snapshots) => json_response(200, json!({ "snapshots": snapshots })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugSnapshotsProjected", error))
        }
    }
}

pub(crate) async fn debug_dry_run(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => {
            return error_output_response_for_server(
                &state.server,
                "/_routecodex/debug/dry-run",
                "pre-request",
                projected,
            );
        }
    };
    let fixture_id = match required_dry_run_string(&payload, "fixture_id") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ));
        }
    };
    let method = match required_dry_run_string(&payload, "method") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ));
        }
    };
    let path = match required_dry_run_string(&payload, "path") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ));
        }
    };
    let Some(request_payload) = payload.get("request_payload").cloned() else {
        return foundation_output_response(project_v3_debug_failure(
            "V3DryRunFixtureRegistered",
            V3DebugError::MalformedFixture("request_payload is required".to_string()),
        ));
    };
    let Some(response_payload) = payload.get("response_payload").cloned() else {
        return foundation_output_response(project_v3_debug_failure(
            "V3DryRunFixtureRegistered",
            V3DebugError::MalformedFixture("response_payload is required".to_string()),
        ));
    };
    let output = execute_v3_responses_direct_dry_run_runtime(
        V3DryRunFixture {
            fixture_id,
            server_id: state.server.id.clone(),
            method,
            path,
            request_payload,
            response_payload,
        },
        &state.manifest,
        &state.debug,
        V3ResponsesDirectDryRunExecutionEnv::new(),
    )
    .await;
    foundation_output_response(output)
}

fn required_dry_run_string(
    payload: &serde_json::Value,
    field: &'static str,
) -> Result<String, V3DebugError> {
    payload
        .get(field)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| V3DebugError::MalformedFixture(format!("{field} is required")))
}
