use crate::*;
use axum::body::Body;
use axum::extract::{Request, State, WebSocketUpgrade};
use axum::http::{HeaderMap, Response, StatusCode};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn responses_websocket_endpoint(
    State(state): State<Arc<V3ListenerState>>,
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

// feature_id: v3.responses_inbound_websocket_proxy
pub(crate) async fn responses_websocket_session(
    state: Arc<V3ListenerState>,
    headers: HeaderMap,
    execution_mode: V3EntryProtocolExecutionMode,
    pending_owner_symbol: Option<String>,
    mut socket: WebSocket,
) {
    while let Some(message) = socket.next().await {
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
        )
        .await
        .is_err()
        {
            break;
        }
    }
}

pub(crate) async fn handle_responses_websocket_message_with_mode(
    state: &Arc<V3ListenerState>,
    headers: &HeaderMap,
    socket: &mut WebSocket,
    bytes: &[u8],
    execution_mode: V3EntryProtocolExecutionMode,
    pending_owner_symbol: Option<String>,
) -> Result<(), ()> {
    let payload = match responses_websocket_create_payload(bytes) {
        Ok(payload) => payload,
        Err(message) => {
            let _ = send_responses_websocket_error(socket, "invalid_client_event", message).await;
            return Err(());
        }
    };
    let request_id = match next_v3_console_request_identity(state, "/v1/responses", Some(&payload))
    {
        Ok(identity) => identity.request_id,
        Err(message) => {
            let _ = send_responses_websocket_error(socket, "runtime_error", message).await;
            return Err(());
        }
    };
    let execution_id = state.debug.next_execution_id(&state.server.id);
    let entry_facts = V3ResponsesContinuationEntryFacts::project(&payload);
    let protocol_plan = None;
    let owner_resolution_context = match build_responses_previous_response_owner_resolution_context(
        headers,
        &request_id,
        &state.server,
        "/v1/responses",
        &entry_facts,
    ) {
        Ok(context) => context,
        Err(message) => {
            let _ = send_responses_websocket_error(socket, "invalid_request", message).await;
            return Err(());
        }
    };
    let effective_execution_mode =
        match resolve_v3_responses_previous_response_owner_execution_mode_at_req03(
            entry_facts.previous_response_id.as_deref(),
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
            Ok(mode) => responses_effective_execution_mode_for_entry_facts(mode, &entry_facts),
            Err(error) => {
                let message = project_v3_responses_previous_response_owner_resolution_error(error)
                    .body
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Responses continuation owner resolution failed")
                    .to_string();
                let _ = send_responses_websocket_error(socket, "invalid_request", message).await;
                return Err(());
            }
        };
    match effective_execution_mode {
        V3EntryProtocolExecutionMode::Direct => {
            let outcome = execute_responses_direct_server_outcome(
                state,
                headers,
                "WEBSOCKET".to_string(),
                "/v1/responses".to_string(),
                request_id,
                execution_id,
                payload,
                protocol_plan.as_ref(),
                None,
                None,
                None,
            )
            .await;
            match outcome {
                V3ResponsesDirectServerOutcome::DirectFrame(frame) => {
                    send_responses_websocket_frame(socket, frame).await
                }
                V3ResponsesDirectServerOutcome::RelayOutput(output) => {
                    send_responses_relay_websocket_output(socket, output).await
                }
            }
        }
        V3EntryProtocolExecutionMode::Relay => {
            let outcome = execute_responses_relay_websocket_output(
                state,
                headers,
                request_id,
                execution_id,
                payload,
                protocol_plan.as_ref(),
            )
            .await;
            match outcome {
                V3ResponsesDirectServerOutcome::DirectFrame(frame) => {
                    send_responses_websocket_frame(socket, frame).await
                }
                V3ResponsesDirectServerOutcome::RelayOutput(output) => {
                    send_responses_relay_websocket_output(socket, output).await
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
    execution_id: String,
    payload: Value,
    protocol_plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> V3ResponsesDirectServerOutcome {
    let entry_facts = V3ResponsesContinuationEntryFacts::project(&payload);
    let continuation_scope = match build_responses_relay_local_continuation_scope(
        headers,
        &request_id,
        &state.server,
        "/v1/responses",
        &entry_facts,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            return V3ResponsesDirectServerOutcome::RelayOutput(
                project_v3_responses_relay_runtime_failure(
                    V3ResponsesRelayRuntimeError::ProviderWireEncoding(message),
                ),
            );
        }
    };
    let provider_failure_session_scope =
        get_failure_session_scope(&state.server, headers, "responses", &request_id)
            .expect("responses requests must have session-id for failure isolation");
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(error) => {
            return V3ResponsesDirectServerOutcome::RelayOutput(
                project_v3_responses_relay_runtime_failure(
                    V3ResponsesRelayRuntimeError::ProviderWireEncoding(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
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
        Some(plan) => execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target(
            &state.manifest,
            input,
            &state.provider_health,
            V3ResponsesRelayLocalStoplessControlInput::new(
                &state.responses_relay_local_continuation,
                &state.responses_relay_stopless_control,
                continuation_scope,
                now_epoch_ms,
            ),
            plan.decision.target.clone(),
            plan.expanded.clone(),
            BTreeSet::new(),
            None,
        )
        .await,
        None => execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control(
            &state.manifest,
            input,
            &state.provider_health,
            &state.responses_relay_local_continuation,
            &state.responses_relay_stopless_control,
            continuation_scope,
            now_epoch_ms,
        )
        .await,
    };
    let mut relay_output = match output {
        Ok(output) => output,
        Err(error) => project_v3_responses_relay_runtime_failure(error),
    };
    if let Some(handoff) = relay_output.protocol_direct_handoff.take() {
        let relay_trace = merge_v3_protocol_plan_trace(
            relay_output.node_trace.clone(),
            handoff.node_trace.clone(),
        );
        let mut relay_events = relay_output
            .observability
            .as_ref()
            .map(|observability| observability.provider_failure_events.clone())
            .unwrap_or_default();
        relay_events.extend(handoff.provider_failure_events);
        let outcome = execute_responses_direct_server_outcome(
            state,
            headers,
            "WEBSOCKET".to_string(),
            "/v1/responses".to_string(),
            request_id,
            execution_id,
            handoff.request_payload.clone(),
            Some(&handoff.plan),
            Some(handoff.observability_accumulator),
            None,
            None,
        )
        .await;
        return match outcome {
            V3ResponsesDirectServerOutcome::DirectFrame(mut frame) => {
                prepend_v3_relay_handoff_trace_to_direct_frame(&mut frame, &relay_trace);
                merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
                    &mut frame,
                    relay_events,
                );
                V3ResponsesDirectServerOutcome::DirectFrame(frame)
            }
            V3ResponsesDirectServerOutcome::RelayOutput(mut output) => {
                prepend_v3_protocol_plan_trace_to_responses_relay_output(&mut output, &relay_trace);
                merge_v3_direct_handoff_provider_failure_events(&mut output, relay_events);
                V3ResponsesDirectServerOutcome::RelayOutput(output)
            }
        };
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
        V3Server16Body::Sse(stream) => send_responses_websocket_sse_stream(socket, stream).await,
    }
}

pub(crate) async fn send_responses_websocket_sse_stream(
    socket: &mut WebSocket,
    mut stream: V3ClientSseStream,
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
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                return send_responses_websocket_error(
                    socket,
                    "runtime_stream_error",
                    format!("{}: {}", error.code, error.message),
                )
                .await;
            }
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

pub(crate) async fn send_responses_relay_websocket_output(
    socket: &mut WebSocket,
    output: V3ResponsesRelayRuntimeOutput,
) -> Result<(), ()> {
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
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                return send_responses_websocket_error(socket, "runtime_stream_error", error).await;
            }
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
    let projected = project_v3_server_websocket_error(code, message);
    let event = json!({
        "type": "error",
        "error": projected.body["error"].clone()
    });
    send_responses_websocket_json(socket, &event).await
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
