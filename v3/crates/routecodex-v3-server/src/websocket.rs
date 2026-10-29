use crate::*;
use axum::body::Body;
use axum::extract::{Extension, Request, State, WebSocketUpgrade};
use axum::http::{HeaderMap, Response, StatusCode};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Arc;

pub(crate) async fn responses_websocket_endpoint(
    State(state): State<Arc<V3ListenerState>>,
    headers: HeaderMap,
    connection: Option<Extension<V3FrontConnectionIdentity>>,
    ws: Option<WebSocketUpgrade>,
) -> Response<Body> {
    let response = responses_websocket_upgrade(state.clone(), headers, ws).await;
    commit_model_transport_outcome(
        &state,
        connection.map(|Extension(identity)| identity),
        response,
    )
}

async fn responses_websocket_upgrade(
    state: Arc<V3ListenerState>,
    headers: HeaderMap,
    ws: Option<WebSocketUpgrade>,
) -> Response<Body> {
    let Some(binding) = state
        .manifest
        .hub_v1
        .as_ref()
        .and_then(|hub| hub.entry_protocol_binding_for_endpoint("/v1/responses"))
    else {
        let request_id = match allocate_v3_console_request_id(&state, "/v1/responses", None) {
            Ok(request_id) => request_id,
            Err(response) => return *response,
        };
        return error_output_response_for_server(
            &state.server,
            "/v1/responses",
            &request_id,
            project_http_input_error(
                V3HttpBoundaryErrorKind::EndpointNotEnabled,
                "endpoint path /v1/responses has no entry protocol binding",
            ),
        );
    };
    let entry_protocol = binding.entry_protocol.clone();
    let execution_mode = binding.execution_mode;
    let pending_owner_symbol = binding.pending_owner_symbol.clone();
    if entry_protocol != "responses"
        || !state
            .server
            .endpoints
            .iter()
            .any(|declared| declared == &entry_protocol)
    {
        let request_id = match allocate_v3_console_request_id(&state, "/v1/responses", None) {
            Ok(request_id) => request_id,
            Err(response) => return *response,
        };
        return error_output_response_for_server(
            &state.server,
            "/v1/responses",
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
    let Some(ws) = ws else {
        let request_id = match allocate_v3_console_request_id(&state, "/v1/responses", None) {
            Ok(request_id) => request_id,
            Err(response) => return *response,
        };
        return error_output_response_for_server(
            &state.server,
            "/v1/responses",
            &request_id,
            project_http_input_error(
                V3HttpBoundaryErrorKind::WebSocketUpgradeRequired,
                "WebSocket upgrade is required for GET /v1/responses",
            ),
        );
    };
    if !has_responses_websocket_beta(&headers) {
        let request_id = match allocate_v3_console_request_id(&state, "/v1/responses", None) {
            Ok(request_id) => request_id,
            Err(response) => return *response,
        };
        return error_output_response_for_server(
            &state.server,
            "/v1/responses",
            &request_id,
            project_http_input_error(
                V3HttpBoundaryErrorKind::WebSocketBetaRequired,
                "OpenAI-Beta: responses_websockets=2026-02-06 is required for /v1/responses WebSocket",
            ),
        );
    }
    ws.on_upgrade(move |socket| {
        responses_websocket_session(state, headers, execution_mode, pending_owner_symbol, socket)
    })
}

/// Record a provider terminal on the WebSocket entry as provider-private
/// evidence, exactly as the HTTP/SSE entry does.
///
/// The WebSocket client boundary is a transport break, so this is the only
/// reader the witness has on this entry. The artifact and its shape have one
/// owner (`persist_v3_provider_terminal_evidence`); this only supplies the
/// entry identity, which the endpoint guard above already pins to
/// `/v1/responses` over the `responses` entry protocol.
fn record_responses_websocket_provider_terminal_evidence(
    state: &Arc<V3ListenerState>,
    request_id: &str,
    disposition: &routecodex_v3_error::V3ProviderTerminalDisposition,
) {
    persist_v3_provider_terminal_evidence(
        state,
        "responses",
        "/v1/responses",
        request_id,
        disposition,
    );
}

// feature_id: v3.responses_inbound_websocket_proxy
/// Upper bounds for client events held while one request is in flight.
///
/// The server reads the client socket concurrently with the in-flight
/// request so a legal client Close can cancel a long recovery wait. Text and
/// Binary events read during that wait are held in arrival order and are
/// never treated as a second in-flight request. Once either bound is reached
/// the session stops polling the socket, which reapplies TCP read
/// backpressure to the peer without dropping a queued business message or
/// terminating the recoverable request.
const MAX_HELD_CLIENT_EVENTS: usize = 32;
const MAX_HELD_CLIENT_EVENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct HeldClientEvents {
    events: VecDeque<Message>,
    bytes: usize,
}

impl HeldClientEvents {
    fn push(&mut self, message: Message) {
        self.bytes += responses_websocket_message_retained_size(&message);
        self.events.push_back(message);
    }

    fn pop_front(&mut self) -> Option<Message> {
        let message = self.events.pop_front()?;
        self.bytes -= responses_websocket_message_retained_size(&message);
        Some(message)
    }

    fn at_bound(&self) -> bool {
        self.events.len() >= MAX_HELD_CLIENT_EVENTS || self.bytes >= MAX_HELD_CLIENT_EVENT_BYTES
    }
}

fn responses_websocket_message_retained_size(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
        Message::Close(Some(frame)) => frame.reason.len(),
        Message::Close(None) => 0,
    }
}

pub(crate) async fn responses_websocket_session(
    state: Arc<V3ListenerState>,
    headers: HeaderMap,
    execution_mode: V3EntryProtocolExecutionMode,
    pending_owner_symbol: Option<String>,
    mut socket: WebSocket,
) {
    let mut held_client_events = HeldClientEvents::default();
    loop {
        let message = match held_client_events.pop_front() {
            Some(message) => Some(Ok(message)),
            None => socket.next().await,
        };
        let Some(message) = message else {
            break;
        };
        let message = match message {
            Ok(message) => message,
            Err(_) => break,
        };
        let bytes = match message {
            Message::Text(text) => text.into_bytes(),
            Message::Binary(bytes) => bytes.to_vec(),
            Message::Ping(payload) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(_) => break,
        };
        if handle_responses_websocket_message_with_mode(
            &state,
            &headers,
            &mut socket,
            &bytes,
            execution_mode,
            pending_owner_symbol.clone(),
            &mut held_client_events,
        )
        .await
        .is_err()
        {
            break;
        }
    }
}

/// Poll the client socket while a request is in flight.
///
/// The Runtime buffers every provider attempt before any client frame is
/// projected, so a request can sit in a declared recovery wait with no
/// client-visible traffic. Reading the client socket concurrently keeps that
/// wait cancellable: the client's own Close ends the transport, the request
/// future is dropped (and with it its recovery wait timer), nothing is
/// projected, and no further provider business attempt starts. Transport
/// frames are answered on the spot; client events are held for the session
/// loop and never treated as a second in-flight request. Reaching the held
/// event bound applies read backpressure: the socket is not polled again
/// until the in-flight request settles, so the peer's TCP send window blocks
/// instead of queued business messages being dropped. A client Close sent
/// after that bound is reached is therefore not observed until the request
/// settles; this is the declared bound/cancellation trade-off.
async fn await_outcome_while_observing_client<F>(
    socket: &mut WebSocket,
    future: F,
    held_client_events: &mut HeldClientEvents,
) -> Result<F::Output, ()>
where
    F: std::future::Future,
{
    let mut future = Box::pin(future);
    let mut client_close = false;
    loop {
        if held_client_events.at_bound() {
            return Ok(future.await);
        }
        tokio::select! {
            client_event = socket.next() => {
                match client_event {
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                        held_client_events.push(message);
                    }
                    Some(Ok(Message::Close(_))) => {
                        client_close = true;
                        break;
                    }
                    None | Some(Err(_)) => break,
                }
            }
            outcome = &mut future => return Ok(outcome),
        }
    }
    // Drop the in-flight request future before the transport reply is driven,
    // so the legal client-cancellation path abandons the recovery wait and does
    // not start another provider business attempt for the cancelled request.
    drop(future);
    if client_close {
        // tungstenite queues the protocol Close reply when it reads the client
        // Close. Flush it to the wire before the session releases the socket.
        let _ = socket.flush().await;
    }
    Err(())
}

pub(crate) async fn handle_responses_websocket_message_with_mode(
    state: &Arc<V3ListenerState>,
    headers: &HeaderMap,
    socket: &mut WebSocket,
    bytes: &[u8],
    execution_mode: V3EntryProtocolExecutionMode,
    pending_owner_symbol: Option<String>,
    held_client_events: &mut HeldClientEvents,
) -> Result<(), ()> {
    let payload = match responses_websocket_create_payload(bytes) {
        Ok(payload) => payload,
        Err(message) => {
            let _ = send_responses_websocket_error(socket, "invalid_client_event", message).await;
            return Err(());
        }
    };
    let payload = match routecodex_v3_runtime::operation_runner::execute_v3_operation_runner_request_capture_client_json(payload) {
        Ok(captured) => captured,
        Err(error) => {
            let result = routecodex_v3_runtime::project_v3_server_boundary_error_via_sdk(
                routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
                "V3OperationRunnerCaptureClientJson",
                "operation_runner_capture_client_json_failed",
                error.to_string(),
                Some(598),
            );
            let _ = send_responses_websocket_error_sdk_result(socket, result).await;
            return Err(());
        }
    };
    if payload
        .get("previous_response_id")
        .is_some_and(|value| !value.is_null())
    {
        let _ = send_responses_websocket_error(
            socket,
            "invalid_request",
            "Responses continuation is retired: previous_response_id is unsupported",
        )
        .await;
        return Err(());
    }
    let request_identity =
        match next_v3_console_request_identity(state, "/v1/responses", Some(&payload)) {
            Ok(identity) => identity,
            Err(message) => {
                let _ = send_responses_websocket_error(socket, "runtime_error", message).await;
                return Err(());
            }
        };
    let request_id = request_identity.request_id.clone();
    // The executors below take `request_id` by value, but the provider-terminal
    // arms still need it to record provider-private evidence.
    let evidence_request_id = request_id.clone();
    let execution_id = state.debug.next_execution_id(&state.server.id);
    let execution_scope = state
        .debug
        .start_trace(&state.server.id, &request_id, &execution_id)
        .ok();
    let entry_facts = V3ResponsesEntryFacts::project(&payload);
    let protocol_plan = None;
    let effective_execution_mode =
        responses_effective_execution_mode_for_entry_facts(execution_mode, &entry_facts);
    match effective_execution_mode {
        V3EntryProtocolExecutionMode::Direct => {
            let outcome = match await_outcome_while_observing_client(
                socket,
                execute_responses_direct_server_outcome(
                    state,
                    headers,
                    "WEBSOCKET".to_string(),
                    "/v1/responses".to_string(),
                    request_id,
                    Some(request_identity.pipeline_id.clone()),
                    execution_id,
                    payload,
                    protocol_plan.as_ref(),
                    None,
                    None,
                    None,
                    None,
                    None,
                    V3RequestPurpose::Conversation,
                ),
                held_client_events,
            )
            .await
            {
                Ok(outcome) => outcome,
                Err(()) => return Err(()),
            };
            outcome.publish_observations(
                state,
                execution_scope.as_ref(),
                "responses",
                "/v1/responses",
                &evidence_request_id,
            );
            match outcome {
                V3ResponsesDirectServerOutcome::ProviderTerminal(terminal) => {
                    // A provider terminal never projects onto the client. The
                    // WebSocket client boundary is a transport break, exactly
                    // like the HTTP/SSE boundary: close without a payload. The
                    // provider's own status, headers, and body are recorded as
                    // provider-private evidence first, because otherwise the
                    // witness built and carried across every attempt would be
                    // dropped at this boundary with no reader at all.
                    record_responses_websocket_provider_terminal_evidence(
                        state,
                        &evidence_request_id,
                        &terminal.disposition,
                    );
                    Err(())
                }
                V3ResponsesDirectServerOutcome::DirectFrame(frame) => {
                    send_responses_websocket_frame(socket, frame).await
                }
                V3ResponsesDirectServerOutcome::RelayOutput(output) => {
                    send_responses_relay_websocket_output(
                        state,
                        &evidence_request_id,
                        socket,
                        output,
                    )
                    .await
                }
            }
        }
        V3EntryProtocolExecutionMode::Relay => {
            let outcome = match await_outcome_while_observing_client(
                socket,
                execute_responses_relay_websocket_output(
                    state,
                    headers,
                    request_id,
                    request_identity.pipeline_id.clone(),
                    execution_id,
                    payload,
                    protocol_plan.as_ref(),
                ),
                held_client_events,
            )
            .await
            {
                Ok(outcome) => outcome,
                Err(()) => return Err(()),
            };
            outcome.publish_observations(
                state,
                execution_scope.as_ref(),
                "responses",
                "/v1/responses",
                &evidence_request_id,
            );
            match outcome {
                V3ResponsesDirectServerOutcome::ProviderTerminal(terminal) => {
                    // A provider terminal never projects onto the client. The
                    // WebSocket client boundary is a transport break, exactly
                    // like the HTTP/SSE boundary: close without a payload. The
                    // provider's own status, headers, and body are recorded as
                    // provider-private evidence first, because otherwise the
                    // witness built and carried across every attempt would be
                    // dropped at this boundary with no reader at all.
                    record_responses_websocket_provider_terminal_evidence(
                        state,
                        &evidence_request_id,
                        &terminal.disposition,
                    );
                    Err(())
                }
                V3ResponsesDirectServerOutcome::DirectFrame(frame) => {
                    send_responses_websocket_frame(socket, frame).await
                }
                V3ResponsesDirectServerOutcome::RelayOutput(output) => {
                    send_responses_relay_websocket_output(
                        state,
                        &evidence_request_id,
                        socket,
                        output,
                    )
                    .await
                }
            }
        }
        V3EntryProtocolExecutionMode::PendingNotImplemented => {
            let owner = pending_owner_symbol
                .as_deref()
                .unwrap_or("missing_pending_owner");
            send_responses_websocket_error(
                socket,
                "runtime_error",
                format!("Responses WebSocket binding is pending owner {owner}"),
            )
            .await
        }
    }
}

pub(crate) async fn execute_responses_relay_websocket_output(
    state: &Arc<V3ListenerState>,
    headers: &HeaderMap,
    request_id: String,
    pipeline_id: String,
    execution_id: String,
    payload: Value,
    protocol_plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> V3ResponsesDirectServerOutcome {
    let provider_failure_session_scope =
        match get_failure_session_scope(&state.server, headers, &request_id) {
            Ok(scope) => scope,
            Err(message) => {
                return V3ResponsesDirectServerOutcome::RelayOutput(
                    project_v3_responses_relay_runtime_failure(
                        V3ResponsesRelayRuntimeError::ProviderWireEncoding(message),
                        None,
                    ),
                );
            }
        };
    let input = V3ResponsesRelayRuntimeInput {
        server_id: state.server.id.clone(),
        failure_session_scope: provider_failure_session_scope.clone(),
        request_id: request_id.clone(),
        payload: payload.clone(),
    };
    let output = match protocol_plan {
        Some(plan) => {
            execute_v3_responses_relay_runtime_with_default_transport_health(
                &state.manifest,
                input,
                &state.provider_health,
                V3ResponsesRelayProviderSnapshotCapture::new(false, false),
                None,
                None,
                Some(plan.decision.target.clone()),
                Some(plan.expanded.clone()),
                BTreeSet::new(),
                plan.relay_runtime_seeds(),
            )
            .await
        }
        None => {
            execute_v3_responses_relay_runtime_with_default_transport_health(
                &state.manifest,
                input,
                &state.provider_health,
                V3ResponsesRelayProviderSnapshotCapture::new(false, false),
                None,
                None,
                None,
                None,
                BTreeSet::new(),
                V3ResponsesRelayRuntimeSeeds::default(),
            )
            .await
        }
    };
    let mut relay_output = match output {
        Ok(output) => output,
        Err(error) => project_v3_responses_relay_runtime_failure(error, None),
    };
    if let Some(handoff) = relay_output.protocol_direct_handoff.take() {
        let relay_trace = relay_output.node_trace.clone();
        let mut relay_events = relay_output
            .observability
            .as_ref()
            .map(|observability| observability.provider_failure_events.clone())
            .unwrap_or_default();
        relay_events.extend(handoff.provider_failure_events);
        let request_execution_control = handoff.request_execution_control;
        let mut outcome = execute_responses_direct_server_outcome(
            state,
            headers,
            "WEBSOCKET".to_string(),
            "/v1/responses".to_string(),
            request_id,
            Some(pipeline_id),
            execution_id,
            handoff.request_payload.clone(),
            Some(&handoff.plan),
            Some(handoff.observability_accumulator),
            Some(request_execution_control),
            None,
            None,
            None,
            V3RequestPurpose::Conversation,
        )
        .await;
        outcome.prepend_observations(&relay_trace, relay_events);
        return outcome;
    }
    V3ResponsesDirectServerOutcome::RelayOutput(relay_output)
}

pub(crate) fn responses_websocket_create_payload(
    bytes: &[u8],
) -> Result<serde_json::Value, String> {
    let mut event: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("client WebSocket event is not valid JSON: {error}"))?;
    let object = event
        .as_object_mut()
        .ok_or_else(|| "client WebSocket event must be a JSON object".to_string())?;
    match object
        .remove("type")
        .and_then(|value| value.as_str().map(str::to_string))
    {
        Some(event_type) if event_type == "response.create" => Ok(()),
        Some(event_type) => Err(format!(
            "unsupported client WebSocket event type {event_type}; expected response.create"
        )),
        None => Err("client WebSocket event is missing type".to_string()),
    }?;
    if object.contains_key("response") {
        return Err(
            "response.create must be a flat event; nested response payload is unsupported"
                .to_string(),
        );
    }
    Ok(event)
}

pub(crate) async fn send_responses_websocket_frame(
    socket: &mut WebSocket,
    frame: V3Server16HttpFrame,
) -> Result<(), ()> {
    if !frame.error_chain.is_empty() || frame.status >= 400 {
        let message = match frame.body {
            V3Server16Body::Json(value) => value
                .pointer("/error/message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("V3 Responses runtime error")
                .to_string(),
            V3Server16Body::Bytes(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            V3Server16Body::Sse(_) => "V3 Responses runtime stream error".to_string(),
            V3Server16Body::CommittedSse(_) => "V3 Responses runtime stream error".to_string(),
        };
        return send_responses_websocket_error(socket, "runtime_error", message).await;
    }
    match frame.body {
        V3Server16Body::Json(value) => {
            let event = json!({"type": "response.completed", "response": value});
            send_responses_websocket_json(socket, &event).await
        }
        V3Server16Body::Bytes(bytes) => {
            let value: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(error) => {
                    return send_responses_websocket_error(
                        socket,
                        "runtime_error",
                        format!("runtime byte frame is not valid JSON: {error}"),
                    )
                    .await;
                }
            };
            let event = json!({"type": "response.completed", "response": value});
            send_responses_websocket_json(socket, &event).await
        }
        V3Server16Body::Sse(_) => {
            send_responses_websocket_error(
                socket,
                "runtime_error",
                "V3 Responses live stream is not supported on websocket",
            )
            .await
        }
        V3Server16Body::CommittedSse(stream) => {
            send_responses_websocket_committed_sse_stream(socket, stream).await
        }
    }
}

pub(crate) async fn send_responses_websocket_committed_sse_stream(
    socket: &mut WebSocket,
    mut stream: V3CommittedClientSseStream,
) -> Result<(), ()> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    loop {
        let next_chunk = tokio::select! {
            client_message = socket.next() => {
                match client_message {
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            return Err(());
                        }
                        continue;
                    }
                    Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err(()),
                    Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {
                        return send_responses_websocket_error(
                            socket,
                            "invalid_client_event",
                            "response.create is already in flight",
                        )
                        .await;
                    }
                }
            }
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = next_chunk else {
            break;
        };
        let frames = match decoder.push(build_v3_sse_transport_in_01_raw_chunk(&chunk)) {
            Ok(frames) => frames,
            Err(error) => {
                return send_responses_websocket_error(
                    socket,
                    "runtime_stream_error",
                    error.to_string(),
                )
                .await;
            }
        };
        for frame in frames {
            match responses_websocket_event_text_from_sse_fields(frame.frame().fields()) {
                Ok(Some(text)) => {
                    if socket.send(Message::Text(text)).await.is_err() {
                        return Err(());
                    }
                }
                Ok(None) => return Ok(()),
                Err(message) => {
                    return send_responses_websocket_error(socket, "runtime_stream_error", message)
                        .await;
                }
            }
        }
    }
    match decoder.finish() {
        Ok(()) => Ok(()),
        Err(error) => {
            send_responses_websocket_error(
                socket,
                "runtime_stream_error",
                format!("runtime SSE stream did not terminate cleanly: {error}"),
            )
            .await
        }
    }
}

pub(crate) async fn send_responses_relay_websocket_output(
    state: &Arc<V3ListenerState>,
    request_id: &str,
    socket: &mut WebSocket,
    output: V3ResponsesRelayRuntimeOutput,
) -> Result<(), ()> {
    if let Some(disposition) = output.terminal_disposition.as_ref() {
        // A provider terminal never projects onto the client: close the socket
        // without a payload, exactly like the HTTP/SSE transport break. The
        // witness is still recorded as provider-private evidence first, because
        // the relay lane is a client boundary with no other reader.
        record_responses_websocket_provider_terminal_evidence(state, request_id, disposition);
        return Err(());
    }
    if !output.error_chain.as_ref().is_none_or(Vec::is_empty) || output.status >= 400 {
        let message = match output.client_body {
            V3ResponsesRelayClientBody::Json(value) => value
                .pointer("/error/message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("V3 Responses Relay runtime error")
                .to_string(),
            V3ResponsesRelayClientBody::Sse(_) => {
                "V3 Responses Relay runtime stream error".to_string()
            }
        };
        return send_responses_websocket_error(socket, "runtime_error", message).await;
    }
    match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => {
            let event = json!({"type": "response.completed", "response": value});
            send_responses_websocket_json(socket, &event).await
        }
        V3ResponsesRelayClientBody::Sse(stream) => {
            send_responses_relay_websocket_sse_stream(socket, stream).await
        }
    }
}

pub(crate) async fn send_responses_relay_websocket_sse_stream(
    socket: &mut WebSocket,
    mut stream: V3ResponsesRelayClientStream,
) -> Result<(), ()> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    loop {
        let next_chunk = tokio::select! {
            client_message = socket.next() => {
                match client_message {
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            return Err(());
                        }
                        continue;
                    }
                    Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err(()),
                    Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {
                        return send_responses_websocket_error(
                            socket,
                            "invalid_client_event",
                            "response.create is already in flight",
                        )
                        .await;
                    }
                }
            }
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = next_chunk else {
            break;
        };
        let frames = match decoder.push(build_v3_sse_transport_in_01_raw_chunk(&chunk)) {
            Ok(frames) => frames,
            Err(error) => {
                return send_responses_websocket_error(
                    socket,
                    "runtime_stream_error",
                    format!("runtime SSE decode failed: {error}"),
                )
                .await;
            }
        };
        for frame in frames {
            match responses_websocket_event_text_from_sse_fields(frame.frame().fields()) {
                Ok(Some(text)) => {
                    if socket.send(Message::Text(text)).await.is_err() {
                        return Err(());
                    }
                }
                Ok(None) => return Ok(()),
                Err(message) => {
                    return send_responses_websocket_error(socket, "runtime_stream_error", message)
                        .await;
                }
            }
        }
    }
    match decoder.finish() {
        Ok(()) => Ok(()),
        Err(error) => {
            send_responses_websocket_error(
                socket,
                "runtime_stream_error",
                format!("runtime SSE stream did not terminate cleanly: {error}"),
            )
            .await
        }
    }
}

pub(crate) fn responses_websocket_event_text_from_sse_fields(
    fields: &[SseField],
) -> Result<Option<String>, String> {
    let mut data_lines = Vec::new();
    for field in fields {
        if let SseField::Named { name, value } = field {
            if name == "data" {
                data_lines.push(value.as_str());
            }
        }
    }
    if data_lines.is_empty() {
        return Ok(None);
    }
    let data = data_lines.join("\n");
    if data.trim() == "[DONE]" {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_str(&data)
        .map_err(|error| format!("runtime SSE data is not valid JSON: {error}"))?;
    Ok(Some(value.to_string()))
}

pub(crate) async fn send_responses_websocket_error(
    socket: &mut WebSocket,
    code: &'static str,
    message: impl Into<String>,
) -> Result<(), ()> {
    let result = routecodex_v3_runtime::project_v3_server_websocket_error_via_sdk(code, message);
    send_responses_websocket_error_sdk_result(socket, result).await
}

pub(crate) async fn send_responses_websocket_error_sdk_result(
    socket: &mut WebSocket,
    result: Result<
        routecodex_v3_error::V3Error06ClientProjected,
        routecodex_v3_runtime::V3RelayErrorOperatorFault,
    >,
) -> Result<(), ()> {
    match result {
        Ok(projected) => send_responses_websocket_projected_error(socket, projected).await,
        Err(fault) => {
            send_responses_websocket_sdk_fault_diagnostic(fault);
            Err(())
        }
    }
}

fn send_responses_websocket_sdk_fault_diagnostic(
    fault: routecodex_v3_runtime::V3RelayErrorOperatorFault,
) {
    let policy = &fault.policy_failure;
    let original = fault
        .original_source
        .as_ref()
        .map(|source| {
            format!(
                "original_kind={:?} original_stage={} original_code={} original_message={:?}",
                source.source_kind, source.source_stage, source.code, source.message
            )
        })
        .unwrap_or_else(|| "original=<none>".to_string());
    let message = format!(
        "[v3-websocket-internal-error] class=runtime_failure policy_kind={:?} policy_stage={} policy_code={} policy_message={:?} {}",
        policy.source_kind, policy.source_stage, policy.code, policy.message, original
    );
    #[cfg(test)]
    record_responses_websocket_sdk_fault_diagnostic(&message);
    eprintln!("{message}");
}

#[cfg(test)]
static RESPONSES_WEBSOCKET_SDK_FAULT_DIAGNOSTICS: std::sync::OnceLock<
    std::sync::Mutex<Vec<String>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
fn record_responses_websocket_sdk_fault_diagnostic(message: &str) {
    RESPONSES_WEBSOCKET_SDK_FAULT_DIAGNOSTICS
        .get_or_init(|| std::sync::Mutex::new(Vec::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(message.to_string());
}

#[cfg(test)]
pub(crate) fn take_responses_websocket_sdk_fault_diagnostics() -> Vec<String> {
    RESPONSES_WEBSOCKET_SDK_FAULT_DIAGNOSTICS
        .get_or_init(|| std::sync::Mutex::new(Vec::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .drain(..)
        .collect()
}

async fn send_responses_websocket_projected_error(
    _socket: &mut WebSocket,
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> Result<(), ()> {
    eprintln!(
        "[v3-websocket-internal-error] class={} cause={}",
        projected.error_class, projected.error_detail
    );
    Err(())
}

pub(crate) async fn send_responses_websocket_json(
    socket: &mut WebSocket,
    event: &serde_json::Value,
) -> Result<(), ()> {
    socket
        .send(Message::Text(event.to_string()))
        .await
        .map_err(|_| ())
}

pub(crate) fn has_responses_websocket_beta(headers: &HeaderMap) -> bool {
    headers
        .get("openai-beta")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim() == "responses_websockets=2026-02-06")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_projection_uses_json_data_not_opaque_event_label() {
        let fields = vec![
            SseField::Named {
                name: "event".to_string(),
                value: "provider.label".to_string(),
            },
            SseField::Named {
                name: "data".to_string(),
                value: r#"{"type":"response.completed"}"#.to_string(),
            },
        ];
        assert_eq!(
            responses_websocket_event_text_from_sse_fields(&fields).unwrap(),
            Some(r#"{"type":"response.completed"}"#.to_string())
        );
    }

    #[test]
    fn websocket_projection_does_not_synthesize_json_from_event_only_frame() {
        let fields = vec![SseField::Named {
            name: "event".to_string(),
            value: "response.completed".to_string(),
        }];
        assert_eq!(
            responses_websocket_event_text_from_sse_fields(&fields).unwrap(),
            None
        );
    }
}
