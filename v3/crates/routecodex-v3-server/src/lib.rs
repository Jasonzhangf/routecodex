use axum::body::{to_bytes, Body};
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Request, State,
};
use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Response, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3DebugManifest, V3EntryProtocolExecutionMode, V3ServerManifest,
};
use routecodex_v3_debug::{
    V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_error::{project_v3_http_boundary_error, V3HttpBoundaryErrorKind};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw, execute_v3_anthropic_relay_runtime_with_default_transport,
    execute_v3_foundation_pending_runtime, execute_v3_gemini_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport,
    execute_v3_responses_direct_dry_run_runtime,
    execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation,
    execute_v3_responses_relay_dry_run_runtime,
    execute_v3_responses_relay_runtime_with_default_transport,
    execute_v3_responses_relay_runtime_with_default_transport_and_local_continuation,
    project_v3_anthropic_relay_runtime_failure, project_v3_debug_failure,
    project_v3_gemini_relay_runtime_failure, project_v3_openai_chat_relay_runtime_failure,
    project_v3_responses_relay_runtime_failure, register_responses_direct_hooks,
    V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput, V3ClientBody, V3ClientSseStream,
    V3FoundationRuntimeInput, V3FoundationRuntimeOutput, V3GeminiRelayClientBody,
    V3GeminiRelayRuntimeInput, V3GeminiRelayRuntimeOutput, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput, V3OpenAiChatRelayRuntimeOutput, V3Resp15ClientPayload,
    V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
    V3ResponsesRelayClientBody, V3ResponsesRelayLocalContinuationScope,
    V3ResponsesRelayLocalContinuationState, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayRuntimeOutput,
};
use serde_json::{json, Map, Value};
use sse_transport_core::{
    build_sse_transport_in_01_raw_chunk, build_sse_transport_in_02_from_fields,
    build_sse_transport_in_03_from_sse_transport_in_02,
    build_sse_transport_out_04_from_sse_transport_in_03, SseField, SseIncrementalDecoder,
    SseTransportLimits,
};
use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const V3_PROTOCOL_PENDING_PROJECTION_RESOURCE: &str = "v3.protocol.pending_projection";

#[derive(Clone)]
struct V3ListenerState {
    server: V3ServerManifest,
    manifest_version: u16,
    manifest: Arc<V3Config05ManifestPublished>,
    debug: V3DebugRuntime,
    responses_direct_continuation: Arc<V3ResponsesDirectContinuationState>,
    responses_relay_local_continuation: Arc<V3ResponsesRelayLocalContinuationState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ServerStartup01ListenerSetPreflight {
    pub manifest_version: u16,
    pub listeners: Vec<V3ServerManifest>,
}

#[derive(Debug)]
pub struct V3Server16HttpFrame {
    pub status: u16,
    pub content_type: String,
    pub body: V3Server16Body,
    pub debug_node: &'static str,
    pub error_node: &'static str,
    pub error_chain: Vec<&'static str>,
    pub node_trace: Vec<&'static str>,
}

pub enum V3Server16Body {
    Json(serde_json::Value),
    Bytes(Vec<u8>),
    Sse(V3ClientSseStream),
}

impl fmt::Debug for V3Server16Body {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(value) => formatter.debug_tuple("Json").field(value).finish(),
            Self::Bytes(bytes) => formatter
                .debug_struct("Bytes")
                .field("byte_len", &bytes.len())
                .finish(),
            Self::Sse(_) => formatter.write_str("Sse(<server-event-stream>)"),
        }
    }
}

#[derive(Debug)]
pub struct V3ListenerHandle {
    pub server_id: String,
    pub addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Debug)]
pub struct V3ServerAggregateHandle {
    pub listeners: Vec<V3ListenerHandle>,
}

pub fn build_v3_server_startup_01_listener_set_from_config_05(
    manifest: &V3Config05ManifestPublished,
) -> V3ServerStartup01ListenerSetPreflight {
    V3ServerStartup01ListenerSetPreflight {
        manifest_version: manifest.version,
        listeners: manifest
            .servers
            .values()
            .filter(|server| server.enabled)
            .cloned()
            .collect(),
    }
}

impl V3ServerAggregateHandle {
    pub async fn shutdown(mut self) {
        for listener in &mut self.listeners {
            if let Some(shutdown) = listener.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }
}

pub async fn spawn_v3_server_aggregate(
    manifest: V3Config05ManifestPublished,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    let manifest = Arc::new(manifest);
    let preflight = build_v3_server_startup_01_listener_set_from_config_05(&manifest);
    let debug =
        build_v3_debug_runtime_from_manifest(&manifest.debug).map_err(std::io::Error::other)?;
    let responses_direct_continuation = Arc::new(V3ResponsesDirectContinuationState::default());
    let responses_relay_local_continuation =
        Arc::new(V3ResponsesRelayLocalContinuationState::default());
    let mut bound = Vec::with_capacity(preflight.listeners.len());
    for server in preflight.listeners {
        let addr: SocketAddr = format!("{}:{}", server.bind, server.port)
            .parse()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let listener = TcpListener::bind(addr).await?;
        let bound_addr = listener.local_addr()?;
        bound.push((server, listener, bound_addr));
    }

    let mut listeners = Vec::with_capacity(bound.len());
    for (server, listener, addr) in bound {
        let server_id = server.id.clone();
        let app = build_v3_listener_router(V3ListenerState {
            server,
            manifest_version: preflight.manifest_version,
            manifest: manifest.clone(),
            debug: debug.clone(),
            responses_direct_continuation: responses_direct_continuation.clone(),
            responses_relay_local_continuation: responses_relay_local_continuation.clone(),
        });
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        listeners.push(V3ListenerHandle {
            server_id,
            addr,
            shutdown: Some(shutdown_tx),
        });
    }
    for listener in &listeners {
        let scope = debug
            .start_trace(&listener.server_id, "startup", "listener")
            .map_err(std::io::Error::other)?;
        debug
            .record_node_event(
                &scope,
                "V3ServerStartup01ListenerSetPreflight",
                "listening",
                Some(json!({
                    "server_id": listener.server_id,
                    "address": listener.addr.to_string()
                })),
            )
            .map_err(std::io::Error::other)?;
    }
    Ok(V3ServerAggregateHandle { listeners })
}

pub async fn serve_v3_server_aggregate_until_shutdown(
    manifest: V3Config05ManifestPublished,
) -> Result<(), std::io::Error> {
    let handle = spawn_v3_server_aggregate(manifest).await?;
    tokio::signal::ctrl_c().await?;
    handle.shutdown().await;
    Ok(())
}

fn build_v3_listener_router(state: V3ListenerState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models_endpoint))
        .route(
            "/v1/responses",
            post(pending_endpoint).get(responses_websocket_endpoint),
        )
        .route("/v1/messages", post(pending_endpoint))
        .route("/v1/chat/completions", post(pending_endpoint))
        .route(
            "/v1beta/models/:model/generateContent",
            post(pending_endpoint),
        )
        .route("/_routecodex/debug/status", get(debug_status))
        .route("/_routecodex/debug/logs", get(debug_logs))
        .route("/_routecodex/debug/snapshots", get(debug_snapshots))
        .route("/_routecodex/debug/dry-run", post(debug_dry_run))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(path_not_found)
        .with_state(Arc::new(state))
}

async fn health(State(state): State<Arc<V3ListenerState>>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": 3,
        "manifest_version": state.manifest_version,
        "server_id": state.server.id,
        "bind": state.server.bind,
        "port": state.server.port,
    }))
}

async fn models_endpoint(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    json_response(200, build_v3_models_catalog(&state.manifest))
}

async fn pending_endpoint(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let request_headers = request.headers().clone();
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let Some(binding) = state
        .manifest
        .hub_v1
        .as_ref()
        .and_then(|hub| hub.entry_protocol_binding_for_endpoint(&path))
    else {
        return error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::EndpointNotEnabled,
            format!("endpoint path {path} has no entry protocol binding"),
        ));
    };
    let entry_protocol = binding.entry_protocol.clone();
    let execution_mode = binding.execution_mode;
    let pending_owner_symbol = binding.pending_owner_symbol.clone();
    if !state
        .server
        .endpoints
        .iter()
        .any(|declared| declared == &entry_protocol)
    {
        return error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::EndpointNotEnabled,
            format!(
                "endpoint protocol {entry_protocol} is not enabled on server {}",
                state.server.id
            ),
        ));
    }
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => return error_output_response(projected),
    };
    let request_id = state.debug.next_request_id(&state.server.id);
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
            ))
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
    if is_provider_request_dry_run(&request_headers)
        && entry_protocol == "responses"
        && execution_mode == V3EntryProtocolExecutionMode::Direct
    {
        let output = execute_v3_responses_direct_dry_run_runtime(
            V3DryRunFixture {
                fixture_id: request_id.clone(),
                server_id: state.server.id.clone(),
                method,
                path,
                request_payload: payload,
                response_payload: json!({
                    "id": format!("dry_run_{request_id}"),
                    "object": "response",
                    "status": "completed",
                    "output_text": "routecodex provider-request dry-run stopped before provider send"
                }),
            },
            &state.manifest,
            &state.debug,
        )
        .await;
        return foundation_output_response(output);
    }
    if is_provider_request_dry_run(&request_headers)
        && entry_protocol == "responses"
        && execution_mode == V3EntryProtocolExecutionMode::Relay
    {
        let output = execute_v3_responses_relay_dry_run_runtime(
            &state.manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                payload,
            },
        )
        .await;
        return foundation_output_response(output);
    }
    if entry_protocol == "openai_chat" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output = match execute_v3_openai_chat_completions_request(
            &state.manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
        };
        return openai_chat_relay_output_response(output);
    }
    if entry_protocol == "anthropic" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let stream = payload.get("stream").and_then(serde_json::Value::as_bool) == Some(true);
        let output = match execute_v3_anthropic_messages_request(
            &state.manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_anthropic_relay_runtime_failure(error),
        };
        return anthropic_relay_output_response(output, stream);
    }
    if entry_protocol == "gemini" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let output = match execute_v3_gemini_generate_content_request(
            &state.manifest,
            V3GeminiRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id,
                endpoint_path: path.clone(),
                payload,
            },
        )
        .await
        {
            Ok(output) => output,
            Err(error) => project_v3_gemini_relay_runtime_failure(error),
        };
        return gemini_relay_output_response(output);
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Relay {
        let continuation_scope = match build_responses_relay_local_continuation_scope(
            &request_headers,
            &request_id,
            &state.server,
            &path,
        ) {
            Ok(scope) => scope,
            Err(message) => {
                return error_output_response(project_http_input_error(
                    V3HttpBoundaryErrorKind::MalformedJson,
                    message,
                ))
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
                ))
            }
        };
        let output =
            match execute_v3_responses_relay_runtime_with_default_transport_and_local_continuation(
                &state.manifest,
                V3ResponsesRelayRuntimeInput {
                    server_id: state.server.id.clone(),
                    request_id,
                    payload,
                },
                &state.responses_relay_local_continuation,
                continuation_scope,
                now_epoch_ms,
            )
            .await
            {
                Ok(output) => output,
                Err(error) => project_v3_responses_relay_runtime_failure(error),
            };
        return responses_relay_output_response(output);
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        let frame = execute_responses_direct_server_frame(
            &state,
            &request_headers,
            method,
            path,
            request_id,
            execution_id,
            payload,
        )
        .await;
        responses_direct_output_response(frame)
    } else if execution_mode == V3EntryProtocolExecutionMode::PendingNotImplemented {
        let pending_not_implemented = execution_mode.as_str();
        let Some(pending_owner) = pending_owner_symbol else {
            return error_output_response(project_http_input_error(
                V3HttpBoundaryErrorKind::EndpointNotEnabled,
                format!(
                    "entry protocol {entry_protocol} pending binding lacks explicit pending owner"
                ),
            ));
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
        pending_binding_output_response(
            output,
            &entry_protocol,
            pending_not_implemented,
            &pending_owner,
        )
    } else {
        error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::EndpointNotEnabled,
            format!(
                "entry protocol {entry_protocol} is bound to unsupported execution mode {}",
                execution_mode.as_str()
            ),
        ))
    }
}

fn is_provider_request_dry_run(headers: &HeaderMap) -> bool {
    headers
        .get("x-routecodex-dry-run")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("provider-request"))
}

async fn responses_websocket_endpoint(
    State(state): State<Arc<V3ListenerState>>,
    headers: HeaderMap,
    ws: Option<WebSocketUpgrade>,
) -> Response<Body> {
    let Some(ws) = ws else {
        return error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::WebSocketUpgradeRequired,
            "WebSocket upgrade is required for GET /v1/responses",
        ));
    };
    if !has_responses_websocket_beta(&headers) {
        return error_output_response(project_http_input_error(
            V3HttpBoundaryErrorKind::WebSocketBetaRequired,
            "OpenAI-Beta: responses_websockets=2026-02-06 is required for /v1/responses WebSocket",
        ));
    }
    ws.on_upgrade(move |socket| responses_websocket_session(state, headers, socket))
}

// feature_id: v3.responses_inbound_websocket_proxy
async fn responses_websocket_session(
    state: Arc<V3ListenerState>,
    headers: HeaderMap,
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
        if handle_responses_websocket_message(&state, &headers, &mut socket, &bytes)
            .await
            .is_err()
        {
            break;
        }
    }
}

async fn handle_responses_websocket_message(
    state: &Arc<V3ListenerState>,
    headers: &HeaderMap,
    socket: &mut WebSocket,
    bytes: &[u8],
) -> Result<(), ()> {
    let payload = match responses_websocket_create_payload(bytes) {
        Ok(payload) => payload,
        Err(message) => {
            let _ = send_responses_websocket_error(socket, "invalid_client_event", message).await;
            return Err(());
        }
    };
    let request_id = state.debug.next_request_id(&state.server.id);
    let execution_id = state.debug.next_execution_id(&state.server.id);
    let frame = execute_responses_direct_server_frame(
        state,
        headers,
        "WEBSOCKET".to_string(),
        "/v1/responses".to_string(),
        request_id,
        execution_id,
        payload,
    )
    .await;
    send_responses_websocket_frame(socket, frame).await
}

fn responses_websocket_create_payload(bytes: &[u8]) -> Result<serde_json::Value, String> {
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

async fn send_responses_websocket_frame(
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
                    .await
                }
            };
            let event = json!({"type": "response.completed", "response": value});
            send_responses_websocket_json(socket, &event).await
        }
        V3Server16Body::Sse(stream) => send_responses_websocket_sse_stream(socket, stream).await,
    }
}

async fn send_responses_websocket_sse_stream(
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
        let frames = match decoder.push(build_sse_transport_in_01_raw_chunk(&chunk)) {
            Ok(frames) => frames,
            Err(error) => {
                return send_responses_websocket_error(
                    socket,
                    "runtime_stream_error",
                    format!("runtime SSE decode failed: {error}"),
                )
                .await
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

fn responses_websocket_event_text_from_sse_fields(
    fields: &[SseField],
) -> Result<Option<String>, String> {
    let mut event_name: Option<&str> = None;
    let mut data_lines = Vec::new();
    for field in fields {
        if let SseField::Named { name, value } = field {
            if name == "event" {
                event_name = Some(value.as_str());
            } else if name == "data" {
                data_lines.push(value.as_str());
            }
        }
    }
    if data_lines.is_empty() {
        return Ok(Some(
            json!({"type": event_name.unwrap_or("response.event")}).to_string(),
        ));
    }
    let data = data_lines.join("\n");
    if data.trim() == "[DONE]" {
        return Ok(None);
    }
    let mut value: serde_json::Value = serde_json::from_str(&data)
        .map_err(|error| format!("runtime SSE data is not valid JSON: {error}"))?;
    if value.get("type").is_none() {
        if let (Some(event_name), Some(object)) = (event_name, value.as_object_mut()) {
            object.insert(
                "type".to_string(),
                serde_json::Value::String(event_name.to_string()),
            );
        }
    }
    Ok(Some(value.to_string()))
}

async fn send_responses_websocket_error(
    socket: &mut WebSocket,
    code: &'static str,
    message: impl Into<String>,
) -> Result<(), ()> {
    let event = json!({
        "type": "error",
        "error": {
            "code": code,
            "message": message.into()
        }
    });
    send_responses_websocket_json(socket, &event).await
}

async fn send_responses_websocket_json(
    socket: &mut WebSocket,
    event: &serde_json::Value,
) -> Result<(), ()> {
    socket
        .send(Message::Text(event.to_string()))
        .await
        .map_err(|_| ())
}

fn has_responses_websocket_beta(headers: &HeaderMap) -> bool {
    headers
        .get("openai-beta")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim() == "responses_websockets=2026-02-06")
        })
}

async fn execute_responses_direct_server_frame(
    state: &V3ListenerState,
    request_headers: &HeaderMap,
    method: String,
    path: String,
    request_id: String,
    execution_id: String,
    payload: serde_json::Value,
) -> V3Server16HttpFrame {
    let continuation_scope = match build_responses_direct_continuation_scope(
        request_headers,
        &request_id,
        &state.server,
        &path,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            return build_v3_server_16_http_frame_from_v3_error_06(project_http_input_error(
                V3HttpBoundaryErrorKind::MalformedJson,
                message,
            ))
        }
    };
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(error) => {
            return build_v3_server_16_http_frame_from_v3_foundation_output(
                project_v3_debug_failure(
                    "V3HubReqContinuation03Classified",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ),
            )
        }
    };
    let output =
        execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation(
            &state.responses_direct_continuation,
            &state.manifest,
            build_v3_server_03_http_request_raw(
                state.server.id.clone(),
                request_id.clone(),
                execution_id.clone(),
                method,
                path,
                payload,
            ),
            continuation_scope,
            register_responses_direct_hooks(),
            &state.debug,
            now_epoch_ms,
        )
        .await;
    let scope = match state
        .debug
        .start_trace(&state.server.id, &request_id, &execution_id)
    {
        Ok(scope) => scope,
        Err(error) => {
            return build_v3_server_16_http_frame_from_v3_foundation_output(
                project_v3_debug_failure("V3Debug01TraceContextStarted", error),
            )
        }
    };
    if let Err(error) = state.debug.record_node_event(
        &scope,
        "V3Server16HttpFrame",
        "projected",
        Some(json!({"status": output.client_payload.status})),
    ) {
        return build_v3_server_16_http_frame_from_v3_foundation_output(project_v3_debug_failure(
            "V3Server16HttpFrame",
            error,
        ));
    }
    build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    )
}

fn pending_binding_output_response(
    output: V3FoundationRuntimeOutput,
    entry_protocol: &str,
    pending_not_implemented: &str,
    pending_owner: &str,
) -> Response<Body> {
    let mut response = foundation_output_response(output);
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-entry-protocol",
        entry_protocol,
    );
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-execution-mode",
        pending_not_implemented,
    );
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-pending-owner",
        pending_owner,
    );
    insert_v3_projection_header(
        response.headers_mut(),
        "x-routecodex-v3-pending-resource",
        V3_PROTOCOL_PENDING_PROJECTION_RESOURCE,
    );
    response
}

fn insert_v3_projection_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    headers.insert(
        name,
        HeaderValue::from_str(value)
            .expect("V3 binding projection header value is validated ASCII"),
    );
}

fn build_responses_direct_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
) -> Result<V3ResponsesDirectContinuationScope, String> {
    let turn_metadata = match headers.get("x-codex-turn-metadata") {
        Some(value) => {
            let text = value
                .to_str()
                .map_err(|error| format!("x-codex-turn-metadata is not UTF-8: {error}"))?;
            Some(
                serde_json::from_str::<serde_json::Value>(text)
                    .map_err(|error| format!("x-codex-turn-metadata is not valid JSON: {error}"))?,
            )
        }
        None => None,
    };
    let session_id = header_text(headers, "session-id")?
        .or_else(|| {
            turn_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("session_id"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| request_id.to_string());
    let conversation_id = header_text(headers, "thread-id")?
        .or_else(|| {
            turn_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("thread_id"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| session_id.clone());
    Ok(V3ResponsesDirectContinuationScope::responses(
        endpoint,
        session_id,
        conversation_id,
        server.port,
        server.routing_group.clone(),
    ))
}

fn build_responses_relay_local_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
) -> Result<V3ResponsesRelayLocalContinuationScope, String> {
    let turn_metadata = match headers.get("x-codex-turn-metadata") {
        Some(value) => {
            let text = value
                .to_str()
                .map_err(|error| format!("x-codex-turn-metadata is not UTF-8: {error}"))?;
            Some(
                serde_json::from_str::<serde_json::Value>(text)
                    .map_err(|error| format!("x-codex-turn-metadata is not valid JSON: {error}"))?,
            )
        }
        None => None,
    };
    let session_id = header_text(headers, "session-id")?
        .or_else(|| {
            turn_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("session_id"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| request_id.to_string());
    let conversation_id = header_text(headers, "thread-id")?
        .or_else(|| {
            turn_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("thread_id"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| session_id.clone());
    Ok(V3ResponsesRelayLocalContinuationScope::responses(
        endpoint,
        session_id,
        conversation_id,
        server.port,
        server.routing_group.clone(),
    ))
}

fn header_text(headers: &HeaderMap, name: &str) -> Result<Option<String>, String> {
    headers
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map(str::trim)
                .map(ToOwned::to_owned)
                .map_err(|error| format!("{name} is not UTF-8: {error}"))
        })
        .transpose()
        .map(|value| value.filter(|value| !value.is_empty()))
}

pub async fn execute_v3_anthropic_messages_request(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> Result<V3AnthropicRelayRuntimeOutput, routecodex_v3_runtime::V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_openai_chat_completions_request(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
) -> Result<V3OpenAiChatRelayRuntimeOutput, routecodex_v3_runtime::V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_gemini_generate_content_request(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
) -> Result<V3GeminiRelayRuntimeOutput, routecodex_v3_runtime::V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_responses_relay_request(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> Result<V3ResponsesRelayRuntimeOutput, routecodex_v3_runtime::V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_default_transport(manifest, input).await
}

fn responses_relay_output_response(output: V3ResponsesRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3ResponsesRelayClientBody::Json(_) => "application/json",
        V3ResponsesRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Responses Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = match output.client_body {
        V3ResponsesRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3ResponsesRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Responses Relay projection"),
        ),
    };
    builder
        .body(body)
        .expect("typed V3 Responses Relay response")
}

fn openai_chat_relay_output_response(output: V3OpenAiChatRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(_) => "application/json",
        V3OpenAiChatRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 OpenAI Chat Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3OpenAiChatRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 OpenAI Chat Relay projection"),
        ),
    };
    builder
        .body(body)
        .expect("typed V3 OpenAI Chat Relay response")
}

fn gemini_relay_output_response(output: V3GeminiRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3GeminiRelayClientBody::Json(_) => "application/json",
        V3GeminiRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Gemini Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = match output.client_body {
        V3GeminiRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3GeminiRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Gemini Relay projection"),
        ),
    };
    builder.body(body).expect("typed V3 Gemini Relay response")
}

fn anthropic_relay_output_response(
    output: V3AnthropicRelayRuntimeOutput,
    stream: bool,
) -> Response<Body> {
    let stream = stream && output.error_chain.is_none();
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Relay status"))
        .header(
            "content-type",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = if stream {
        anthropic_relay_sse_body(output.client_response)
    } else {
        Body::from(
            serde_json::to_vec(&output.client_response)
                .expect("typed V3 Anthropic Relay projection"),
        )
    };
    builder
        .body(body)
        .expect("typed V3 Anthropic Relay response")
}

fn anthropic_relay_sse_body(client_response: serde_json::Value) -> Body {
    let Some(events) = client_response
        .get("events")
        .and_then(serde_json::Value::as_array)
        .cloned()
    else {
        return Body::from_stream(stream::once(async {
            Err::<Vec<u8>, io::Error>(io::Error::other(
                "typed V3 Anthropic Relay SSE projection is missing events",
            ))
        }));
    };
    Body::from_stream(stream::iter(
        events
            .into_iter()
            .map(|event| anthropic_relay_sse_event_chunk(&event)),
    ))
}

fn anthropic_relay_sse_event_chunk(event: &serde_json::Value) -> Result<Vec<u8>, io::Error> {
    let (Some(name), Some(data)) = (
        event.get("event").and_then(serde_json::Value::as_str),
        event.get("data"),
    ) else {
        return Err(io::Error::other(
            "typed V3 Anthropic Relay SSE event is missing event or data",
        ));
    };
    let decoded = build_sse_transport_in_02_from_fields(vec![
        SseField::Named {
            name: "event".to_string(),
            value: name.to_string(),
        },
        SseField::Named {
            name: "data".to_string(),
            value: data.to_string(),
        },
    ])
    .map_err(|error| io::Error::other(error.to_string()))?;
    let validated = build_sse_transport_in_03_from_sse_transport_in_02(decoded)
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(build_sse_transport_out_04_from_sse_transport_in_03(&validated).into_bytes())
}

async fn debug_status(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.status() {
        Ok(status) => json_response(200, json!({ "debug": status })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugStatusProjected", error))
        }
    }
}

async fn debug_logs(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.logs() {
        Ok(logs) => json_response(200, json!({ "logs": logs })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugLogsProjected", error))
        }
    }
}

async fn debug_snapshots(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.snapshots() {
        Ok(snapshots) => json_response(200, json!({ "snapshots": snapshots })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugSnapshotsProjected", error))
        }
    }
}

async fn debug_dry_run(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => return error_output_response(projected),
    };
    let fixture_id = match required_dry_run_string(&payload, "fixture_id") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ))
        }
    };
    let method = match required_dry_run_string(&payload, "method") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ))
        }
    };
    let path = match required_dry_run_string(&payload, "path") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ))
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

fn foundation_output_response(output: V3FoundationRuntimeOutput) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_foundation_output(output);
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type)
        .header("x-routecodex-v3-debug-node", frame.debug_node);
    if frame.error_chain.is_empty() {
        builder = builder.header("x-routecodex-v3-no-network-send", "true");
    } else {
        builder = builder
            .header("x-routecodex-v3-error-node", frame.error_node)
            .header("x-routecodex-v3-error-chain", frame.error_chain.join(","));
    }
    let body = match frame.body {
        V3Server16Body::Json(value) => {
            serde_json::to_vec(&value).expect("V3Server16 JSON projection")
        }
        V3Server16Body::Bytes(bytes) => bytes,
        V3Server16Body::Sse(stream) => {
            return builder
                .body(v3_client_sse_body(stream))
                .expect("typed response")
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

fn responses_direct_output_response(frame: V3Server16HttpFrame) -> Response<Body> {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type)
        .header("x-routecodex-v3-debug-node", frame.debug_node)
        .header("x-routecodex-v3-node-trace", frame.node_trace.join(","));
    if !frame.error_chain.is_empty() {
        builder = builder
            .header("x-routecodex-v3-error-node", frame.error_node)
            .header("x-routecodex-v3-error-chain", frame.error_chain.join(","));
    }
    let body = match frame.body {
        V3Server16Body::Json(value) => {
            serde_json::to_vec(&value).expect("V3Server16 JSON projection")
        }
        V3Server16Body::Bytes(bytes) => bytes,
        V3Server16Body::Sse(stream) => {
            return builder
                .body(v3_client_sse_body(stream))
                .expect("typed response")
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

fn v3_client_sse_body(stream: V3ClientSseStream) -> Body {
    Body::from_stream(stream.map(|result| {
        result.map_err(|error| io::Error::other(format!("{}: {}", error.code, error.message)))
    }))
}

pub fn build_v3_server_16_http_frame_from_v3_resp_15(
    payload: V3Resp15ClientPayload,
    mut node_trace: Vec<&'static str>,
    error_chain: Option<Vec<&'static str>>,
) -> V3Server16HttpFrame {
    node_trace.push("V3Server16HttpFrame");
    let content_type = payload
        .headers
        .get("content-type")
        .expect("V3Resp15ClientPayload owns a validated content-type")
        .clone();
    let error_chain = error_chain.unwrap_or_default();
    V3Server16HttpFrame {
        status: payload.status,
        content_type,
        body: match payload.body {
            V3ClientBody::Json(value) => V3Server16Body::Json(value),
            V3ClientBody::Bytes(bytes) => V3Server16Body::Bytes(bytes),
            V3ClientBody::Sse(stream) => V3Server16Body::Sse(stream),
        },
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: if error_chain.is_empty() {
            "none"
        } else {
            "V3Error06ClientProjected"
        },
        error_chain,
        node_trace,
    }
}

// feature_id: v3.models_capability_catalog
fn build_v3_models_catalog(manifest: &V3Config05ManifestPublished) -> serde_json::Value {
    let mut data = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for builtin_model_id in ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] {
        let mut item = build_v3_codex_model_metadata(builtin_model_id, builtin_model_id, None);
        item.insert("owned_by".to_string(), json!("openai"));
        seen.insert(builtin_model_id.to_string());
        data.push(Value::Object(item));
    }
    for provider in manifest
        .providers
        .values()
        .filter(|provider| provider.enabled)
    {
        for model in provider.models.values() {
            let visible_ids = if model.aliases.is_empty() {
                vec![model.id.clone()]
            } else {
                model.aliases.clone()
            };
            for visible_id in visible_ids {
                if seen.contains(&visible_id) {
                    continue;
                }
                let mut item =
                    build_v3_codex_model_metadata(&visible_id, &model.id, model.max_context_tokens);
                item.insert(
                    "owned_by".to_string(),
                    json!(format!("provider:{}", provider.id)),
                );
                item.insert("provider_id".to_string(), json!(provider.id));
                item.insert("canonical_model_id".to_string(), json!(model.id));
                item.insert("wire_model".to_string(), json!(model.wire_name));
                item.insert("aliases".to_string(), json!(model.aliases));
                item.insert("capabilities".to_string(), json!(model.capabilities));
                item.insert(
                    "supports_streaming".to_string(),
                    json!(model.supports_streaming),
                );
                item.insert(
                    "supports_thinking".to_string(),
                    json!(model.supports_thinking),
                );
                item.insert("thinking".to_string(), json!(model.thinking));
                item.insert("max_tokens".to_string(), json!(model.max_tokens));
                item.insert(
                    "max_context_tokens".to_string(),
                    json!(model.max_context_tokens),
                );
                item.insert("features".to_string(), json!(model.features));
                seen.insert(visible_id);
                data.push(Value::Object(item));
            }
        }
    }
    let models = data.clone();
    json!({
        "object": "list",
        "data": data,
        "models": models,
    })
}

fn build_v3_codex_model_metadata(
    visible_id: &str,
    canonical_model_id: &str,
    max_context_tokens: Option<u64>,
) -> Map<String, Value> {
    let is_gpt_55 = canonical_model_id == "gpt-5.5";
    let is_gpt_56_sol = canonical_model_id == "gpt-5.6-sol";
    let is_gpt_56_terra = canonical_model_id == "gpt-5.6-terra";
    let is_gpt_56_luna = canonical_model_id == "gpt-5.6-luna";
    let is_gpt_56 = is_gpt_56_sol || is_gpt_56_terra || is_gpt_56_luna;
    let is_builtin_bare = visible_id == canonical_model_id && (is_gpt_55 || is_gpt_56);
    let preset_context_window = if is_gpt_55 {
        Some(272_000)
    } else if is_gpt_56 {
        Some(372_000)
    } else {
        None
    };
    let context_window = if is_builtin_bare {
        preset_context_window.or(max_context_tokens)
    } else {
        max_context_tokens.or(preset_context_window)
    }
    .unwrap_or(128_000);
    let description = if is_gpt_55 {
        "Frontier model for complex coding, research, and real-world work."
    } else if is_gpt_56_sol {
        "Latest frontier agentic coding model."
    } else if is_gpt_56_terra {
        "Balanced agentic coding model for everyday work."
    } else if is_gpt_56_luna {
        "Fast and affordable agentic coding model."
    } else {
        "RouteCodex advanced agentic coding model compatible with gpt-5.5 capabilities."
    };
    let default_reasoning_level = if is_gpt_56_sol { "low" } else { "medium" };
    let supported_reasoning_levels = if is_gpt_56_sol || is_gpt_56_terra {
        json!([
            {"effort":"low","description":"Fast responses with lighter reasoning"},
            {"effort":"medium","description":"Balances speed and reasoning depth for everyday tasks"},
            {"effort":"high","description":"Greater reasoning depth for complex problems"},
            {"effort":"xhigh","description":"Extra high reasoning depth for complex problems"},
            {"effort":"max","description":"Maximum reasoning depth for the hardest tasks"},
            {"effort":"ultra","description":"Ultra reasoning depth for frontier-grade tasks"}
        ])
    } else if is_gpt_56_luna {
        json!([
            {"effort":"low","description":"Fast responses with lighter reasoning"},
            {"effort":"medium","description":"Balances speed and reasoning depth for everyday tasks"},
            {"effort":"high","description":"Greater reasoning depth for complex problems"},
            {"effort":"xhigh","description":"Extra high reasoning depth for complex problems"},
            {"effort":"max","description":"Maximum reasoning depth for the hardest tasks"}
        ])
    } else {
        json!([
            {"effort":"low","description":"Fast responses with lighter reasoning"},
            {"effort":"medium","description":"Balances speed and reasoning depth for everyday tasks"},
            {"effort":"high","description":"Greater reasoning depth for complex problems"},
            {"effort":"xhigh","description":"Extra high reasoning depth for complex problems"}
        ])
    };
    let mut item = Map::from_iter([
        ("id".to_string(), json!(visible_id)),
        ("object".to_string(), json!("model")),
        ("owned_by".to_string(), json!("provider")),
        ("slug".to_string(), json!(visible_id)),
        ("display_name".to_string(), json!(visible_id)),
        ("base_instructions".to_string(), json!("")),
        ("description".to_string(), json!(description)),
        ("prefer_websockets".to_string(), json!(false)),
        ("support_verbosity".to_string(), json!(true)),
        ("default_verbosity".to_string(), json!("low")),
        ("apply_patch_tool_type".to_string(), json!("freeform")),
        ("web_search_tool_type".to_string(), json!("text_and_image")),
        ("supports_search_tool".to_string(), json!(true)),
        ("input_modalities".to_string(), json!(["text", "image"])),
        ("supports_image_detail_original".to_string(), json!(true)),
        (
            "truncation_policy".to_string(),
            json!({"mode":"tokens","limit":10000}),
        ),
        ("supports_parallel_tool_calls".to_string(), json!(true)),
        (
            "reasoning_summary_format".to_string(),
            json!("experimental"),
        ),
        ("supports_reasoning_summaries".to_string(), json!(true)),
        ("default_reasoning_summary".to_string(), json!("none")),
        (
            "default_reasoning_level".to_string(),
            json!(default_reasoning_level),
        ),
        (
            "supported_reasoning_levels".to_string(),
            supported_reasoning_levels,
        ),
        ("shell_type".to_string(), json!("shell_command")),
        ("visibility".to_string(), json!("list")),
        (
            "minimal_client_version".to_string(),
            json!(if is_gpt_56 {
                "0.144.0"
            } else if is_gpt_55 {
                "0.124.0"
            } else {
                "0.98.0"
            }),
        ),
        ("supported_in_api".to_string(), json!(true)),
        ("priority".to_string(), json!(0)),
        (
            "experimental_supported_tools".to_string(),
            json!(if is_gpt_56 {
                Vec::<&str>::new()
            } else {
                vec!["apply_patch", "web_search"]
            }),
        ),
        ("effective_context_window_percent".to_string(), json!(95)),
        ("context_window".to_string(), json!(context_window)),
        ("max_context_window".to_string(), json!(context_window)),
    ]);
    if is_gpt_55 || is_gpt_56 {
        item.insert("tool_mode".to_string(), json!("code_mode_only"));
        item.insert("use_responses_lite".to_string(), json!(true));
    }
    item
}

pub fn build_v3_server_16_http_frame_from_v3_error_06(
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> V3Server16HttpFrame {
    V3Server16HttpFrame {
        status: projected.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(projected.body),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
    }
}

pub fn build_v3_server_16_http_frame_from_v3_foundation_output(
    output: V3FoundationRuntimeOutput,
) -> V3Server16HttpFrame {
    V3Server16HttpFrame {
        status: output.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(output.body),
        debug_node: output.debug_node,
        error_node: output.error_node,
        error_chain: output.error_chain,
        node_trace: output.node_trace,
    }
}

fn build_v3_debug_runtime_from_manifest(
    manifest: &V3DebugManifest,
) -> Result<V3DebugRuntime, routecodex_v3_debug::V3DebugError> {
    V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: manifest.log_console,
        log_file: manifest.log_file.clone(),
        snapshots_enabled: manifest.snapshots,
        dry_run_enabled: manifest.dry_run,
        raw_request_retention: manifest
            .retention
            .get("raw_requests")
            .copied()
            .unwrap_or(16) as usize,
        raw_response_retention: manifest
            .retention
            .get("raw_responses")
            .copied()
            .unwrap_or(16) as usize,
        event_retention: manifest.retention.get("events").copied().unwrap_or(512) as usize,
        redaction: V3RedactionPolicy::default(),
    })
}

// Preserve the V2 HTTP contract: image-bearing Responses requests may contain
// large data URLs, while the boundary still needs a finite allocation cap.
const V3_MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;

async fn read_json_payload(
    request: Request,
) -> Result<serde_json::Value, routecodex_v3_error::V3Error06ClientProjected> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let Some(content_type) = content_type else {
        return Err(project_http_input_error(
            V3HttpBoundaryErrorKind::ContentTypeRequired,
            "content-type application/json is required",
        ));
    };
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(project_http_input_error(
            V3HttpBoundaryErrorKind::ContentTypeUnsupported,
            format!("unsupported content-type {content_type}"),
        ));
    }
    let bytes = to_bytes(request.into_body(), V3_MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|error| {
            project_http_input_error(
                V3HttpBoundaryErrorKind::BodyTooLarge,
                format!("request body exceeds {V3_MAX_REQUEST_BODY_BYTES} bytes: {error}"),
            )
        })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        project_http_input_error(
            V3HttpBoundaryErrorKind::MalformedJson,
            format!("malformed JSON request body: {error}"),
        )
    })
}

async fn method_not_allowed() -> Response<Body> {
    error_output_response(project_http_input_error(
        V3HttpBoundaryErrorKind::MethodNotAllowed,
        "HTTP method is not allowed for this endpoint",
    ))
}

async fn path_not_found() -> Response<Body> {
    error_output_response(project_http_input_error(
        V3HttpBoundaryErrorKind::PathNotFound,
        "HTTP path is not registered",
    ))
}

fn project_http_input_error(
    kind: V3HttpBoundaryErrorKind,
    message: impl Into<String>,
) -> routecodex_v3_error::V3Error06ClientProjected {
    project_v3_http_boundary_error(kind, message)
}

fn error_output_response(
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> Response<Body> {
    responses_direct_output_response(build_v3_server_16_http_frame_from_v3_error_06(projected))
}

fn json_response(status: u16, body: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::from_u16(status).expect("fixed status"))
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&body).expect("JSON projection"),
        ))
        .expect("fixed response")
}
