// WebSocket provider transport code, split from transport.rs to satisfy
// verify:v3-file-size. Semantics unchanged; the call sites in transport.rs
// were prefixed with `websocket::`.

use super::*;

pub(super) struct WebSocketAttemptSlot<T> {
    slot: OwnedMutexGuard<Option<T>>,
    clean: bool,
}

impl<T> WebSocketAttemptSlot<T> {
    fn new(slot: OwnedMutexGuard<Option<T>>) -> Self {
        Self { slot, clean: false }
    }

    pub(super) fn mark_clean(&mut self) {
        self.clean = true;
    }
}

impl<T> std::ops::Deref for WebSocketAttemptSlot<T> {
    type Target = Option<T>;
    fn deref(&self) -> &Self::Target {
        &self.slot
    }
}

impl<T> std::ops::DerefMut for WebSocketAttemptSlot<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.slot
    }
}

impl<T> Drop for WebSocketAttemptSlot<T> {
    fn drop(&mut self) {
        if !self.clean {
            *self.slot = None;
        }
    }
}

pub(super) fn acquire_connection_slot(
    sessions: &Arc<Mutex<BTreeMap<String, SharedResponsesWebSocket>>>,
    request: &mut V3Transport13ResponsesRequest,
    handoff: &crate::transport_handoff::V3ProviderTransportAttemptBroker,
    attempt_key: Option<&crate::transport_handoff::V3ProviderTransportAttemptKey>,
) -> Result<Option<WebSocketAttemptSlot<ResponsesWebSocket>>, V3ProviderError> {
    let V3Transport13ResponsesRequestKind::WebSocketV2 {
        request_id,
        provider_id,
        canonical_model_id,
        url,
        auth,
        cancellation,
        ..
    } = &request.kind
    else {
        return Ok(None);
    };
    let mark_failed = |error| {
        if let Some(attempt_key) = attempt_key {
            let _ = handoff.transition(
                attempt_key,
                crate::transport_handoff::V3ProviderTransportAttemptState::Failed,
            );
        }
        error
    };
    let session_key = websocket_session_key(provider_id, canonical_model_id, &auth.alias, url);
    let session = match sessions.try_lock() {
        Ok(mut sessions) => sessions
            .entry(session_key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone(),
        Err(_) => Arc::new(Mutex::new(None)),
    };
    ensure_not_cancelled(request_id, provider_id, cancellation.as_ref()).map_err(mark_failed)?;
    if let Ok(connection) = session.clone().try_lock_owned() {
        return Ok(Some(WebSocketAttemptSlot::new(connection)));
    }
    Ok(Some(WebSocketAttemptSlot::new(
        Arc::new(Mutex::new(None)).try_lock_owned().expect("new connection slot is unlocked"),
    )))
}

fn websocket_session_key(
    provider_id: &str,
    canonical_model_id: &str,
    auth_alias: &str,
    url: &str,
) -> String {
    format!("{provider_id}\u{1f}{canonical_model_id}\u{1f}{auth_alias}\u{1f}{url}")
}

#[derive(Default)]
pub(super) struct V3ResponsesWebSocketProtocolAggregate {
    output_items: BTreeMap<u64, Value>,
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
                let output_index =
                    websocket_output_index(event, event_type, request_id, provider_id)?;
                self.output_items.insert(output_index, item.clone());
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
                let item = self.output_items.get_mut(&output_index).ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "response.function_call_arguments.delta arrived before function_call output_item",
                    )
                })?;
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    return Err(websocket_protocol_error(
                        request_id,
                        provider_id,
                        "response.function_call_arguments.delta targets a non-function_call output_item",
                    ));
                }
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
                let item = self.output_items.get_mut(&output_index).ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "response.function_call_arguments.done arrived before function_call output_item",
                    )
                })?;
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    return Err(websocket_protocol_error(
                        request_id,
                        provider_id,
                        "response.function_call_arguments.done targets a non-function_call output_item",
                    ));
                }
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
        if has_terminal_output || self.output_items.is_empty() {
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
            Value::Array(self.output_items.values().cloned().collect()),
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
    connection: WebSocketAttemptSlot<ResponsesWebSocket>,
    request_id: String,
    provider_id: String,
    cancellation: Option<V3ProviderCancellation>,
    emit_done: bool,
    finished: bool,
}

pub(super) fn websocket_sse_stream(
    connection: WebSocketAttemptSlot<ResponsesWebSocket>,
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
                state.connection.mark_clean();
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

#[cfg(test)]
mod websocket_attempt_slot_tests {
    use super::WebSocketAttemptSlot;
    use futures_util::poll;
    use std::future::pending;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::task::Poll;
    use tokio::sync::{oneshot, Mutex};

    struct Value(Arc<AtomicUsize>);

    impl Drop for Value {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn fixture() -> (Arc<Mutex<Option<Value>>>, Arc<AtomicUsize>) {
        let drops = Arc::new(AtomicUsize::new(0));
        (Arc::new(Mutex::new(Some(Value(drops.clone())))), drops)
    }

    fn assert_discarded(slot: &Arc<Mutex<Option<Value>>>, drops: &AtomicUsize) {
        let next = slot.clone().try_lock_owned().expect("slot must unlock");
        assert!(next.is_none(), "unfinished value must be removed before unlock");
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn websocket_attempt_slot_future_drop_discards_before_unlock() {
        let (slot, drops) = fixture();
        let owner = WebSocketAttemptSlot::new(slot.clone().lock_owned().await);
        let mut future = Box::pin(async move {
            let _owner = owner;
            pending::<()>().await;
        });
        assert!(matches!(poll!(future.as_mut()), Poll::Pending));
        assert!(slot.clone().try_lock_owned().is_err());
        drop(future);
        assert_discarded(&slot, &drops);
    }

    #[tokio::test]
    async fn websocket_attempt_slot_timeout_discards_before_unlock() {
        let (slot, drops) = fixture();
        let owner = WebSocketAttemptSlot::new(slot.clone().lock_owned().await);
        let result = tokio::time::timeout(std::time::Duration::from_millis(1), async move {
            let _owner = owner;
            pending::<()>().await;
        })
        .await;
        assert!(result.is_err());
        assert_discarded(&slot, &drops);
    }

    #[tokio::test]
    async fn websocket_attempt_slot_abort_discards_and_clean_retains() {
        let (slot, drops) = fixture();
        let owned_slot = slot.clone();
        let (entered, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _owner = WebSocketAttemptSlot::new(owned_slot.lock_owned().await);
            let _ = entered.send(());
            pending::<()>().await;
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_discarded(&slot, &drops);

        let (clean_slot, clean_drops) = fixture();
        let mut owner = WebSocketAttemptSlot::new(clean_slot.clone().lock_owned().await);
        owner.mark_clean();
        drop(owner);
        assert!(clean_slot.clone().try_lock_owned().unwrap().is_some());
        assert_eq!(clean_drops.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn websocket_attempt_slot_transfer_is_not_clean_completion() {
        let (slot, drops) = fixture();
        let owner = WebSocketAttemptSlot::new(slot.clone().lock_owned().await);
        let stream_owner = Some(owner);
        assert!(slot.clone().try_lock_owned().is_err());
        drop(stream_owner);
        assert_discarded(&slot, &drops);
    }
}

// In-memory only: exercises the real `acquire_connection_slot` owner without
// sockets, listeners, provider calls, or any transport. Two requests that
// share the same provider/model/auth-alias/url must not serialize on a single
// connection slot: request B must obtain its own slot while request A still
// holds the shared slot.
#[cfg(test)]
mod websocket_slot_independence_tests {
    use super::acquire_connection_slot;
    use crate::transport::{
        v3_transport_13_request, SharedResponsesWebSocket, V3Transport13ResponsesRequest,
        V3Transport13ResponsesRequestKind,
    };
    use crate::transport_handoff::V3ProviderTransportAttemptBroker;
    use crate::wire::{
        V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ResponsesStreamIntent,
    };
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn shared_websocket_request(request_id: &str) -> V3Transport13ResponsesRequest {
        v3_transport_13_request(V3Transport13ResponsesRequestKind::WebSocketV2 {
            request_id: request_id.to_string(),
            provider_id: "slot-provider".to_string(),
            canonical_model_id: "slot-model".to_string(),
            url: "wss://slot.example.invalid/v1/responses".to_string(),
            auth: V3ProviderAuthHandle {
                alias: "slot-auth".to_string(),
                secret: V3ProviderAuthSecretHandle::ApiKey("slot-secret".to_string()),
            },
            stream_intent: V3ResponsesStreamIntent::Sse,
            event: serde_json::json!({"type": "response.create"}),
            cancellation: None,
            compatibility_profile: None,
        })
    }

    #[tokio::test]
    async fn request_does_not_wait_for_shared_session_map() {
        let sessions: Arc<Mutex<BTreeMap<String, SharedResponsesWebSocket>>> =
            Arc::new(Mutex::new(BTreeMap::new()));
        let held_map = sessions.lock().await;
        let broker = V3ProviderTransportAttemptBroker::default();
        let mut request = shared_websocket_request("held-map-request");
        let acquired = acquire_connection_slot(&sessions, &mut request, &broker, None);
        drop(held_map);
        assert!(matches!(acquired, Ok(Some(_))), "request must not wait on the shared session map");
    }

    #[tokio::test]
    async fn second_request_obtains_its_own_slot_without_waiting_for_held_slot() {
        let sessions: Arc<Mutex<BTreeMap<String, SharedResponsesWebSocket>>> =
            Arc::new(Mutex::new(BTreeMap::new()));
        let broker = V3ProviderTransportAttemptBroker::default();

        let mut request_a = shared_websocket_request("slot-request-a");
        let mut request_b = shared_websocket_request("slot-request-b");

        // Request A acquires and holds the shared connection slot for the whole
        // test body.
        let _held_slot_a = acquire_connection_slot(&sessions, &mut request_a, &broker, None)
            .expect("request A must acquire its connection slot")
            .expect("request A is a WebSocket request");

        // Request B asks for the same provider/model/auth-alias/url. It must
        // obtain its own slot immediately instead of waiting for A to release.
        let acquired_b = acquire_connection_slot(&sessions, &mut request_b, &broker, None);

        let _slot_b = acquired_b
            .expect("request B must acquire its connection slot")
            .expect("request B is a WebSocket request");
    }
}
