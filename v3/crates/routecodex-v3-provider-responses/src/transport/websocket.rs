// WebSocket provider transport code, split from transport.rs to satisfy
// verify:v3-file-size. Semantics unchanged; the call sites in transport.rs
// were prefixed with `websocket::`.

use super::*;

#[derive(Default)]
pub(super) struct V3ResponsesWebSocketProtocolAggregate {
    function_call_items: BTreeMap<u64, Value>,
}

impl V3ResponsesWebSocketProtocolAggregate {
    pub(super) fn record(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        provider_id: &str,
    ) -> Result<(), V3ProviderError> {
        match event_type {
            "response.output_item.added" | "response.output_item.done" => {
                let Some(item) = event.get("item") else {
                    return Err(websocket_protocol_error(
                        request_id,
                        provider_id,
                        format!("{event_type} is missing item"),
                    ));
                };
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let output_index =
                        websocket_output_index(event, event_type, request_id, provider_id)?;
                    self.function_call_items.insert(output_index, item.clone());
                }
            }
            "response.function_call_arguments.delta" => {
                let output_index =
                    websocket_output_index(event, event_type, request_id, provider_id)?;
                let delta = event.get("delta").and_then(Value::as_str).ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "response.function_call_arguments.delta is missing delta",
                    )
                })?;
                let item = self
                    .function_call_items
                    .get_mut(&output_index)
                    .ok_or_else(|| {
                        websocket_protocol_error(
                            request_id,
                            provider_id,
                            "response.function_call_arguments.delta arrived before function_call output_item",
                        )
                    })?;
                let object = item.as_object_mut().ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "function_call output_item is not an object",
                    )
                })?;
                let current = object
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                object.insert(
                    "arguments".to_string(),
                    Value::String(format!("{current}{delta}")),
                );
            }
            "response.function_call_arguments.done" => {
                let output_index =
                    websocket_output_index(event, event_type, request_id, provider_id)?;
                let arguments =
                    event
                        .get("arguments")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            websocket_protocol_error(
                                request_id,
                                provider_id,
                                "response.function_call_arguments.done is missing arguments",
                            )
                        })?;
                let item = self
                    .function_call_items
                    .get_mut(&output_index)
                    .ok_or_else(|| {
                        websocket_protocol_error(
                            request_id,
                            provider_id,
                            "response.function_call_arguments.done arrived before function_call output_item",
                        )
                    })?;
                let object = item.as_object_mut().ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "function_call output_item is not an object",
                    )
                })?;
                object.insert(
                    "arguments".to_string(),
                    Value::String(arguments.to_string()),
                );
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn apply_responses_websocket_protocol_events_to_terminal_response(
        &self,
        response: &Value,
        request_id: &str,
        provider_id: &str,
    ) -> Result<Value, V3ProviderError> {
        let _owner = V3_RESPONSES_WEBSOCKET_PROTOCOL_AGGREGATION_OWNER;
        let has_terminal_output = response
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|output| !output.is_empty());
        if has_terminal_output || self.function_call_items.is_empty() {
            return Ok(response.clone());
        }

        let source = response.as_object().ok_or_else(|| {
            websocket_protocol_error(
                request_id,
                provider_id,
                "response.completed response is not an object",
            )
        })?;
        let mut projected = Value::Object(source.clone());
        let object = projected.as_object_mut().ok_or_else(|| {
            websocket_protocol_error(
                request_id,
                provider_id,
                "response.completed response is not an object",
            )
        })?;
        object.insert(
            "output".to_string(),
            Value::Array(self.function_call_items.values().cloned().collect()),
        );
        Ok(projected)
    }
}

fn websocket_output_index(
    event: &Value,
    event_type: &str,
    request_id: &str,
    provider_id: &str,
) -> Result<u64, V3ProviderError> {
    event
        .get("output_index")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            websocket_protocol_error(
                request_id,
                provider_id,
                format!("{event_type} is missing output_index"),
            )
        })
}

struct WebSocketSseState {
    connection: OwnedMutexGuard<Option<ResponsesWebSocket>>,
    request_id: String,
    provider_id: String,
    cancellation: Option<V3ProviderCancellation>,
    emit_done: bool,
    finished: bool,
}

impl Drop for WebSocketSseState {
    fn drop(&mut self) {
        if !self.finished {
            *self.connection = None;
        }
    }
}

pub(super) fn websocket_sse_stream(
    connection: OwnedMutexGuard<Option<ResponsesWebSocket>>,
    request_id: String,
    provider_id: String,
    cancellation: Option<V3ProviderCancellation>,
) -> V3ProviderSseStream {
    let state = WebSocketSseState {
        connection,
        request_id,
        provider_id,
        cancellation,
        emit_done: false,
        finished: false,
    };
    Box::pin(stream::unfold(state, |mut state| async move {
        loop {
            if state.emit_done {
                state.emit_done = false;
                state.finished = true;
                return Some((Ok(b"data: [DONE]\n\n".to_vec()), state));
            }
            if state.finished {
                return None;
            }

            let next = match state.connection.as_mut() {
                Some(socket) => {
                    next_websocket_message(
                        socket,
                        state.cancellation.clone(),
                        &state.request_id,
                        &state.provider_id,
                    )
                    .await
                }
                None => Err(websocket_protocol_error(
                    &state.request_id,
                    &state.provider_id,
                    "WebSocket session is unavailable",
                )),
            };
            let message = match next {
                Ok(Some(message)) => message,
                Ok(None) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            "connection closed before terminal response event",
                        )),
                        state,
                    ));
                }
                Err(error) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((Err(error), state));
                }
            };
            let bytes = match message {
                Message::Text(text) => text.as_bytes().to_vec(),
                Message::Binary(bytes) => bytes.to_vec(),
                Message::Ping(payload) => {
                    let result = match state.connection.as_mut() {
                        Some(socket) => socket.send(Message::Pong(payload)).await,
                        None => {
                            state.finished = true;
                            return Some((
                                Err(websocket_protocol_error(
                                    &state.request_id,
                                    &state.provider_id,
                                    "WebSocket session is unavailable",
                                )),
                                state,
                            ));
                        }
                    };
                    if let Err(error) = result {
                        *state.connection = None;
                        state.finished = true;
                        return Some((
                            Err(websocket_transport_error(
                                &state.request_id,
                                &state.provider_id,
                                error,
                            )),
                            state,
                        ));
                    }
                    continue;
                }
                Message::Pong(_) | Message::Frame(_) => continue,
                Message::Close(_) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            "connection closed before terminal response event",
                        )),
                        state,
                    ));
                }
            };
            let server_event: Value = match serde_json::from_slice(&bytes) {
                Ok(event) => event,
                Err(error) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            error,
                        )),
                        state,
                    ));
                }
            };
            let event_type = match server_event.get("type").and_then(Value::as_str) {
                Some(event_type) => event_type,
                None => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            "server event is missing type",
                        )),
                        state,
                    ));
                }
            };
            if let Some(error) = websocket_server_event_error(
                event_type,
                &server_event,
                &state.request_id,
                &state.provider_id,
            ) {
                *state.connection = None;
                state.finished = true;
                return Some((Err(error), state));
            }
            let frame = match websocket_event_to_sse(
                event_type,
                &server_event,
                &state.request_id,
                &state.provider_id,
            ) {
                Ok(frame) => frame,
                Err(error) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((Err(error), state));
                }
            };
            if event_type == "response.completed" {
                state.emit_done = true;
            }
            return Some((Ok(frame), state));
        }
    }))
}

async fn next_websocket_message(
    socket: &mut ResponsesWebSocket,
    cancellation: Option<V3ProviderCancellation>,
    request_id: &str,
    provider_id: &str,
) -> Result<Option<Message>, V3ProviderError> {
    let next = match cancellation {
        Some(cancellation) => {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    let _ = socket.close(None).await;
                    return Err(V3ProviderError::ClientDisconnect {
                        request_id: request_id.to_string(),
                        provider_id: provider_id.to_string(),
                    });
                }
                next = socket.next() => next,
            }
        }
        None => socket.next().await,
    };
    next.transpose()
        .map_err(|error| websocket_transport_error(request_id, provider_id, error))
}

pub(super) fn websocket_server_event_error(
    event_type: &str,
    server_event: &Value,
    request_id: &str,
    provider_id: &str,
) -> Option<V3ProviderError> {
    if event_type == "error" {
        let error = server_event.get("error").unwrap_or(server_event);
        return Some(V3ProviderError::WebSocketProviderEvent {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            status: websocket_error_status(server_event),
            code: websocket_error_code(error),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("provider WebSocket error")
                .to_string(),
        });
    }
    if matches!(event_type, "response.failed" | "response.incomplete") {
        let response_error = server_event.pointer("/response/error");
        return Some(V3ProviderError::WebSocketProviderEvent {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            status: None,
            code: response_error
                .and_then(websocket_error_code)
                .or_else(|| Some(event_type.to_string())),
            message: server_event
                .pointer("/response/error/message")
                .or_else(|| server_event.pointer("/response/incomplete_details/reason"))
                .and_then(Value::as_str)
                .unwrap_or("provider response did not complete")
                .to_string(),
        });
    }
    None
}

fn websocket_error_status(server_event: &Value) -> Option<u16> {
    server_event
        .get("status")
        .or_else(|| server_event.get("status_code"))
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
}

fn websocket_error_code(error: &Value) -> Option<String> {
    error
        .get("code")
        .or_else(|| error.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn websocket_event_to_sse(
    event_type: &str,
    event: &Value,
    request_id: &str,
    provider_id: &str,
) -> Result<Vec<u8>, V3ProviderError> {
    let data = serde_json::to_string(event)
        .map_err(|error| websocket_protocol_error(request_id, provider_id, error))?;
    Ok(format!("event: {event_type}\ndata: {data}\n\n").into_bytes())
}

pub(super) fn websocket_transport_error(
    request_id: &str,
    provider_id: &str,
    error: impl fmt::Display,
) -> V3ProviderError {
    V3ProviderError::WebSocketTransport {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: error.to_string(),
    }
}

pub(super) fn websocket_protocol_error(
    request_id: &str,
    provider_id: &str,
    error: impl fmt::Display,
) -> V3ProviderError {
    V3ProviderError::WebSocketProtocol {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: error.to_string(),
    }
}
