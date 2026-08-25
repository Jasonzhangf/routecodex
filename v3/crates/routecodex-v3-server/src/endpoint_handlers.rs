use crate::*;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Response};
use futures_util::{FutureExt, StreamExt};
use serde_json::{json, Value};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn v3_front_chunk_is_transport_keepalive(bytes: &[u8]) -> bool {
    bytes == b": keepalive\n\n"
}

fn v3_front_json_body_to_sse_frame(bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(bytes.len() + 8);
    frame.extend_from_slice(b"data: ");
    frame.extend_from_slice(bytes);
    frame.extend_from_slice(b"\n\n");
    frame
}

pub(crate) fn v3_front_sse_worker_panic_frame(message: &str) -> Vec<u8> {
    let frame = build_v3_server_16_http_frame_from_v3_error_06(project_v3_post_commit_sse_source(
        raise_v3_sse_runtime_failure(
            "V3ServerRespOutbound05ClientFrame",
            "front_sse_worker_panicked",
            message,
        ),
        599,
    ));
    let V3Server16Body::Json(value) = frame.body else {
        panic!("Front worker panic must project JSON Error06 body");
    };
    let bytes = serde_json::to_vec(&value).expect("typed Front worker panic Error06 projection");
    let mut sse_frame = Vec::with_capacity(bytes.len() + 24);
    sse_frame.extend_from_slice(b"data: ");
    sse_frame.extend_from_slice(&bytes);
    sse_frame.extend_from_slice(b"\n\ndata: [DONE]\n\n");
    sse_frame
}

pub(crate) async fn pending_endpoint_after_responses_admission(
    state: Arc<V3ListenerState>,
    front_connection_identity: Option<V3FrontConnectionIdentity>,
    request_headers: HeaderMap,
    method: String,
    path: String,
    started_at: Instant,
    entry_protocol: String,
    execution_mode: V3EntryProtocolExecutionMode,
    pending_owner_symbol: Option<String>,
    request_purpose: V3RequestPurpose,
    payload: Value,
) -> Response<Body> {
    if v3_entry_request_wants_sse(&request_headers, &payload) {
        return V3FrontSseAcceptSkeleton::accept(
            state,
            front_connection_identity,
            request_headers,
            method,
            path,
            started_at,
            entry_protocol,
            execution_mode,
            pending_owner_symbol,
            request_purpose,
            payload,
        )
        .await;
    }
    pending_endpoint_after_responses_admission_inner(
        state,
        front_connection_identity,
        request_headers,
        method,
        path,
        started_at,
        entry_protocol,
        execution_mode,
        pending_owner_symbol,
        request_purpose,
        payload,
        false,
    )
    .await
}

struct V3FrontSseAcceptSkeleton;

impl V3FrontSseAcceptSkeleton {
    async fn accept(
        state: Arc<V3ListenerState>,
        front_connection_identity: Option<V3FrontConnectionIdentity>,
        request_headers: HeaderMap,
        method: String,
        path: String,
        started_at: Instant,
        entry_protocol: String,
        execution_mode: V3EntryProtocolExecutionMode,
        pending_owner_symbol: Option<String>,
        request_purpose: V3RequestPurpose,
        payload: Value,
    ) -> Response<Body> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
        let front_transport_broker = state.front_transport_broker.clone();
        let keepalive_interval =
            std::time::Duration::from_millis(state.server.http_sse_keepalive_ms);
        tokio::spawn(async move {
            let panic_tx = tx.clone();
            let worker = async move {
                let response = pending_endpoint_after_responses_admission_inner(
                    state,
                    front_connection_identity,
                    request_headers,
                    method,
                    path,
                    started_at,
                    entry_protocol,
                    execution_mode,
                    pending_owner_symbol,
                    request_purpose,
                    payload,
                    true,
                )
                .await;
                let response_is_sse = response
                    .headers()
                    .get(axum::http::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| {
                        value.to_ascii_lowercase().starts_with("text/event-stream")
                    });
                let mut body = response.into_body().into_data_stream();
                let mut emitted_response_frame = false;
                let mut buffered_json_body = Vec::new();
                while let Some(chunk) = body.next().await {
                    match chunk {
                        Ok(bytes) => {
                            if !response_is_sse {
                                buffered_json_body.extend_from_slice(&bytes);
                                continue;
                            }
                            if !v3_front_chunk_is_transport_keepalive(&bytes) {
                                emitted_response_frame = true;
                            }
                            if tx.send(Ok(bytes.to_vec())).await.is_err() {
                                return;
                            }
                        }
                        Err(error) => {
                            let frame = build_v3_server_16_http_frame_from_v3_error_06(
                                project_v3_post_commit_sse_source(
                                    raise_v3_sse_runtime_failure(
                                        "V3ServerRespOutbound05ClientFrame",
                                        "front_sse_response_body_failed",
                                        error.to_string(),
                                    ),
                                    599,
                                ),
                            );
                            let V3Server16Body::Json(value) = frame.body else {
                                panic!("Front response failure must project JSON Error06 body");
                            };
                            let bytes = serde_json::to_vec(&value)
                                .expect("typed Front response Error06 projection");
                            let mut sse_frame = Vec::with_capacity(bytes.len() + 8);
                            sse_frame.extend_from_slice(b"data: ");
                            sse_frame.extend_from_slice(&bytes);
                            sse_frame.extend_from_slice(b"\n\ndata: [DONE]\n\n");
                            let _ = tx.send(Ok(sse_frame)).await;
                            return;
                        }
                    }
                }
                if !response_is_sse && !buffered_json_body.is_empty() {
                    emitted_response_frame = true;
                    if tx
                        .send(Ok(v3_front_json_body_to_sse_frame(&buffered_json_body)))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if tx.send(Ok(b"data: [DONE]\n\n".to_vec())).await.is_err() {
                        return;
                    }
                }
                if !emitted_response_frame {
                    let frame = build_v3_server_16_http_frame_from_v3_error_06(
                        project_v3_post_commit_sse_source(
                            raise_v3_sse_runtime_failure(
                                "V3ServerRespOutbound05ClientFrame",
                                "front_sse_response_empty",
                                "Front SSE response ended without a response frame",
                            ),
                            599,
                        ),
                    );
                    let V3Server16Body::Json(value) = frame.body else {
                        panic!("Front empty response must project JSON Error06 body");
                    };
                    let bytes = serde_json::to_vec(&value)
                        .expect("typed Front empty response Error06 projection");
                    let mut sse_frame = Vec::with_capacity(bytes.len() + 8);
                    sse_frame.extend_from_slice(b"data: ");
                    sse_frame.extend_from_slice(&bytes);
                    sse_frame.extend_from_slice(b"\n\ndata: [DONE]\n\n");
                    let _ = tx.send(Ok(sse_frame)).await;
                }
            };
            if let Err(payload) = AssertUnwindSafe(worker).catch_unwind().await {
                let message = payload
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                    .unwrap_or("Front SSE worker panicked");
                let _ = panic_tx
                    .send(Ok(v3_front_sse_worker_panic_frame(message)))
                    .await;
            }
        });
        let client_stream = futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        });
        let body = v3_io_sse_body(Box::pin(client_stream), Some(keepalive_interval));
        if let Some(connection_identity) = front_connection_identity {
            if let Some(front_socket) = front_transport_broker.front_socket(connection_identity)
            {
                front_socket.set_exec_closeout_frame(v3_responses_sse_error_event_chunk(
                    503,
                    "server_restart_in_progress",
                    "RouteCodex restarted before this response completed",
                ));
            }
        }
        Response::builder()
            .status(axum::http::StatusCode::OK)
            .header("content-type", "text/event-stream")
            // The Front broker owns the client connection.  These headers are
            // part of that transport contract: an intermediary must not buffer
            // semantic frames or turn the broker's keepalive stream into an
            // idle/closed response while the provider side is still running.
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no")
            .body(body)
            .expect("Direct SSE accept response")
    }
}

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
    front_transport_owns_keepalive: bool,
) -> Response<Body> {
    let client_keepalive_interval = (!front_transport_owns_keepalive)
        .then_some(Duration::from_millis(state.server.http_sse_keepalive_ms));
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
                                V3Server16Body::Bytes(_)
                                | V3Server16Body::Sse(_)
                                | V3Server16Body::CommittedSse(_) => None,
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
                    return responses_direct_output_response(frame, client_keepalive_interval);
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
                            V3Server16Body::Bytes(_)
                            | V3Server16Body::Sse(_)
                            | V3Server16Body::CommittedSse(_) => None,
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
                return responses_direct_output_response(frame, client_keepalive_interval);
            }
        }
    }
    let provider_failure_session_scope = match get_failure_session_scope(
        &state.server,
        &request_headers,
        &payload,
        &entry_protocol,
        &request_id,
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
                let frame = build_v3_server_16_http_frame_from_v3_error_06(
                    project_v3_protocol_execution_plan_failure(failure),
                );
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
        if front_transport_owns_keepalive {
            if let Some(connection_identity) = front_connection_identity {
                // The request-stage plan is the only owner of the Front
                // execution mode. The provider response is not consulted.
                // The pipeline identity was allocated at request ingress and
                // is carried beside the request id; it is not reconstructed
                // from payload, provider response, or logs.
                let lease = V3FrontRequestLease::from_responses_execution_plan(
                    &metadata_plan,
                    request_id.clone(),
                    request_identity.pipeline_id.clone(),
                    state.server.id.clone(),
                    state.server.port,
                    provider_failure_session_scope.session_id().to_string(),
                    state.front_transport_broker.generation(),
                    Instant::now(),
                );
                if let Err(error) = state.front_transport_broker.bind_connection_lease(
                    connection_identity,
                    lease,
                    Instant::now(),
                ) {
                    let frame = build_v3_server_16_http_frame_from_v3_error_06(
                        project_v3_server_runtime_failure(
                            "V3Server03HttpRequestRaw",
                            "front_request_lease_binding_failed",
                            error,
                            598,
                        ),
                    );
                    return responses_direct_output_response(
                        project_v3_responses_error_frame_for_request_if_sse(
                            frame,
                            &request_headers,
                            Some(&payload),
                        ),
                        client_keepalive_interval,
                    );
                }
            }
        }
        Some(metadata_plan)
    } else {
        None
    };
    if entry_protocol == "responses"
        && front_transport_owns_keepalive
        && responses_protocol_plan.is_none()
    {
        if let Some(connection_identity) = front_connection_identity {
            // Continuation owner resolution is a request-stage control
            // decision too. It has no fresh provider target plan, so use the
            // server's configured request deadline without consulting the
            // provider response or reconstructing control state from payload.
            let now = Instant::now();
            let lease = V3FrontRequestLease::from_execution_mode(
                match execution_mode {
                    V3EntryProtocolExecutionMode::Direct => V3FrontExecutionMode::Direct,
                    V3EntryProtocolExecutionMode::Relay => V3FrontExecutionMode::Relay,
                    V3EntryProtocolExecutionMode::PendingNotImplemented => {
                        return responses_direct_output_response(
                            project_v3_responses_error_frame_for_request_if_sse(
                                build_v3_server_16_http_frame_from_v3_error_06(
                                    project_v3_server_runtime_failure(
                                        "V3HubReqContinuation03Classified",
                                        "front_execution_mode_missing",
                                        "continuation request has no executable Direct/Relay mode",
                                        598,
                                    ),
                                ),
                                &request_headers,
                                Some(&payload),
                            ),
                            client_keepalive_interval,
                        );
                    }
                },
                request_id.clone(),
                request_identity.pipeline_id.clone(),
                state.server.id.clone(),
                state.server.port,
                provider_failure_session_scope.session_id().to_string(),
                state.front_transport_broker.generation(),
                Duration::from_millis(routecodex_v3_config::default_provider_request_timeout_ms()),
                Duration::from_millis(routecodex_v3_config::default_provider_request_timeout_ms()),
                now,
            );
            if let Err(error) =
                state
                    .front_transport_broker
                    .bind_connection_lease(connection_identity, lease, now)
            {
                return responses_direct_output_response(
                    project_v3_responses_error_frame_for_request_if_sse(
                        build_v3_server_16_http_frame_from_v3_error_06(
                            project_v3_server_runtime_failure(
                                "V3Server03HttpRequestRaw",
                                "front_request_lease_binding_failed",
                                error,
                                598,
                            ),
                        ),
                        &request_headers,
                        Some(&payload),
                    ),
                    client_keepalive_interval,
                );
            }
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
            request_purpose,
        )
        .await;
    }
    if entry_protocol == "openai_chat" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output =
            match execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_execution_mode(
                &state.manifest,
                V3OpenAiChatRelayRuntimeInput {
                    server_id: state.server.id.clone(),
                    failure_session_scope: provider_failure_session_scope.clone(),
                    request_id: request_id.clone(),
                    payload: payload.clone(),
                },
                state.provider_health.runtime_health(),
                V3HubExecutionMode::Relay,
            )
            .await
            {
                Ok(output) => output,
                Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
            };
        if output.error_chain.is_some() {
            let console_context = build_v3_console_emission_context(
                &state,
                &entry_protocol,
                &path,
                &request_identity,
                &request_headers,
                &payload,
            );
            if let Err(error) = record_v3_webui_projected_runtime_failure_for_context(
                &console_context,
                output
                    .error_class
                    .expect("terminal Error06 output must carry Error02 classification"),
                Some(
                    output
                        .error_detail
                        .as_deref()
                        .expect("terminal Error06 output must carry source detail"),
                ),
                output.status,
                "json",
            ) {
                emit_v3_webui_projection_failure(&console_context, &error);
            }
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
        }
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
        return openai_chat_relay_output_response(
            output,
            stream_console_finalizer,
            Duration::from_millis(state.server.http_sse_keepalive_ms),
        );
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
        let console_payload = payload.clone();
        let console_context = build_v3_console_emission_context(
            &state,
            &entry_protocol,
            &path,
            &request_identity,
            &request_headers,
            &console_payload,
        );
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
        );
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
                Some(request_identity.pipeline_id.clone()),
                execution_id,
                handoff.request_payload.clone(),
                Some(&handoff.plan),
                Some(handoff.observability_accumulator),
                Some(provider_failure_event_sink.clone()),
                Some(route_selection_event_sink.clone()),
                request_purpose,
            )
            .await;
            match outcome {
                V3ResponsesDirectServerOutcome::DirectFrame(mut frame) => {
                    prepend_v3_relay_handoff_trace_to_direct_frame(&mut frame, &handoff.node_trace);
                    merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
                        &mut frame,
                        handoff.provider_failure_events,
                    );
                    // Provider failure events describe recovered attempts. They are not a
                    // terminal client error when the handoff eventually returns 2xx; only the
                    // Error06/status truth may create error.json.
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
                    return responses_direct_output_response_with_console(
                        frame,
                        stream_console_finalizer,
                        client_keepalive_interval,
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
        let outcome = execute_responses_direct_server_outcome(
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
                .map(V3MetadataCenterExecutionPlan::protocol_plan),
            None,
            Some(provider_failure_event_sink.clone()),
            Some(route_selection_event_sink.clone()),
            request_purpose,
        )
        .await;
        match outcome {
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

#[cfg(test)]
mod front_sse_contract_tests {
    use super::{
        v3_front_chunk_is_transport_keepalive, v3_front_json_body_to_sse_frame,
        v3_front_sse_worker_panic_frame,
    };

    #[test]
    fn front_sse_worker_panic_projects_internal_error_and_done() {
        let frame = v3_front_sse_worker_panic_frame("worker panic");
        assert_eq!(
            frame,
            b"data: {\"error\":{\"code\":\"front_sse_worker_panicked\",\"message\":\"worker panic\"}}\n\ndata: [DONE]\n\n"
        );
    }

    #[test]
    fn front_keepalive_does_not_commit_a_client_response_frame() {
        assert!(v3_front_chunk_is_transport_keepalive(b": keepalive\n\n"));
        assert!(!v3_front_chunk_is_transport_keepalive(
            b"event: response.created\ndata: {}\n\n"
        ));
        assert!(!v3_front_chunk_is_transport_keepalive(
            b"data: {\"error\":{\"code\":\"front_sse_response_empty\"}}\n\n"
        ));
    }

    #[test]
    fn front_json_error_is_projected_as_one_sse_data_frame() {
        assert_eq!(
            v3_front_json_body_to_sse_frame(br#"{"error":{"code":"internal"}}"#),
            b"data: {\"error\":{\"code\":\"internal\"}}\n\n"
        );
    }

    #[test]
    fn front_empty_json_body_does_not_fake_a_success_frame() {
        assert!(v3_front_json_body_to_sse_frame(b"").is_empty() == false);
        assert!(!v3_front_chunk_is_transport_keepalive(
            &v3_front_json_body_to_sse_frame(b"{}")
        ));
    }
}
