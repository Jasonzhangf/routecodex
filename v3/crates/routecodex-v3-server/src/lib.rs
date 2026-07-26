use axum::body::{to_bytes, Body};
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    ConnectInfo, Request, State,
};
use axum::http::{
    header::{CONTENT_LENGTH, CONTENT_TYPE},
    HeaderMap, HeaderValue, Response, StatusCode,
};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{
    collect_v3_route_group_catalog_model_refs, resolve_routecodex_package_version_from_executable,
    V3Config05ManifestPublished, V3DebugManifest, V3EntryProtocolExecutionMode, V3ServerManifest,
};
use routecodex_v3_debug::{
    V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_error::{
    project_v3_http_boundary_error, V3HttpBoundaryErrorKind, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw, execute_v3_anthropic_relay_dry_run_runtime,
    execute_v3_anthropic_relay_runtime_with_default_transport,
    execute_v3_foundation_pending_runtime, execute_v3_gemini_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport,
    execute_v3_responses_direct_dry_run_runtime, execute_v3_responses_direct_runtime_kernel,
    execute_v3_responses_relay_dry_run_runtime, execute_v3_responses_relay_runtime,
    plan_v3_responses_protocol_execution_with_provider_health,
    project_v3_anthropic_relay_runtime_failure, project_v3_debug_failure,
    project_v3_gemini_relay_runtime_failure, project_v3_openai_chat_relay_runtime_failure,
    project_v3_protocol_execution_plan_failure,
    project_v3_responses_previous_response_owner_resolution_error,
    project_v3_responses_relay_runtime_failure, project_v3_virtual_router_dry_run,
    project_v3_virtual_router_status, register_responses_direct_hooks,
    resolve_v3_responses_previous_response_owner_execution_mode_at_req03,
    V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput, V3ClientBody, V3ClientSseStream,
    V3Execution11ProtocolDecisionMode, V3FoundationRuntimeInput, V3FoundationRuntimeOutput,
    V3GeminiRelayClientBody, V3GeminiRelayRuntimeInput, V3GeminiRelayRuntimeOutput,
    V3LiveSnapResponsesTransport, V3OpenAiChatRelayClientBody, V3OpenAiChatRelayRuntimeInput,
    V3OpenAiChatRelayRuntimeOutput, V3Resp15ClientPayload, V3ResponsesDirectContinuationScope,
    V3ResponsesDirectContinuationState, V3ResponsesDirectDryRunExecutionEnv,
    V3ResponsesDirectExecutionEnv, V3ResponsesDirectRuntimeSharedState,
    V3ResponsesProtocolExecutionPlan, V3ResponsesRelayClientBody, V3ResponsesRelayClientStream,
    V3ResponsesRelayDefaultTransport, V3ResponsesRelayDryRunExecutionEnv,
    V3ResponsesRelayExecutionEnv, V3ResponsesRelayHealthSource,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayLocalStoplessControlInput, V3ResponsesRelayProviderHealthHandle,
    V3ResponsesRelayProviderSnapshotCapture, V3ResponsesRelayRuntimeError,
    V3ResponsesRelayRuntimeInput, V3ResponsesRelayRuntimeOutput,
    V3ResponsesRelayStoplessControlState, V3ResponsesTransport, V3RuntimeObservability,
    V3RuntimeProviderFailureObservation, V3RuntimeStreamObservation, V3RuntimeUsageSummary,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, build_v3_sse_transport_in_02_from_fields,
    build_v3_sse_transport_in_03_from_v3_sse_transport_in_02,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03, SseField, SseIncrementalDecoder,
    SseTransportLimits,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io;
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const V3_PROTOCOL_PENDING_PROJECTION_RESOURCE: &str = "v3.protocol.pending_projection";

mod request_id;
use request_id::{
    format_v3_request_id_entry, format_v3_request_id_token, format_v3_tm, V3RequestIdCounter,
};

mod console;
use console::*;

mod live_snapshot;
use live_snapshot::*;

struct V3ResponsesPreviousResponseOwnerResolutionContext {
    direct_scope: V3ResponsesDirectContinuationScope,
    relay_scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
}

#[derive(Clone)]
struct V3ListenerState {
    server: V3ServerManifest,
    manifest_version: u16,
    manifest: Arc<V3Config05ManifestPublished>,
    debug: V3DebugRuntime,
    console_enabled: bool,
    request_counter: Arc<Mutex<V3RequestIdCounter>>,
    responses_direct_continuation: Arc<V3ResponsesDirectContinuationState>,
    responses_relay_local_continuation: Arc<V3ResponsesRelayLocalContinuationState>,
    responses_relay_stopless_control: Arc<V3ResponsesRelayStoplessControlState>,
    provider_health: Arc<V3ResponsesRelayProviderHealthHandle>,
    responses_direct_transport: Arc<V3ResponsesRelayDefaultTransport>,
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
    pub error_body: Option<Value>,
    pub node_trace: Vec<&'static str>,
    pub observability: Option<V3RuntimeObservability>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
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

    pub async fn shutdown_listener_ports(&mut self, ports: &BTreeSet<u16>) -> Vec<u16> {
        let mut released = Vec::new();
        for listener in &mut self.listeners {
            if !ports.contains(&listener.addr.port()) {
                continue;
            }
            if let Some(shutdown) = listener.shutdown.take() {
                let _ = shutdown.send(());
                released.push(listener.addr.port());
            }
        }
        released
    }

    pub fn has_active_listener(&self) -> bool {
        self.listeners
            .iter()
            .any(|listener| listener.shutdown.is_some())
    }
}

pub async fn spawn_v3_server_aggregate(
    manifest: V3Config05ManifestPublished,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    let console_enabled = manifest.debug.log_console;
    let mut debug_manifest = manifest.debug.clone();
    debug_manifest.log_console = false;
    let manifest = Arc::new(manifest);
    let preflight = build_v3_server_startup_01_listener_set_from_config_05(&manifest);
    let debug =
        build_v3_debug_runtime_from_manifest(&debug_manifest).map_err(std::io::Error::other)?;
    let responses_direct_continuation = Arc::new(V3ResponsesDirectContinuationState::default());
    let responses_relay_local_continuation =
        Arc::new(V3ResponsesRelayLocalContinuationState::default());
    let responses_relay_stopless_control =
        Arc::new(V3ResponsesRelayStoplessControlState::default());
    let provider_health = Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
        &manifest,
    ));
    let responses_direct_transport = Arc::new(V3ResponsesRelayDefaultTransport::default());
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
            console_enabled,
            request_counter: Arc::new(Mutex::new(V3RequestIdCounter::new())),
            responses_direct_continuation: responses_direct_continuation.clone(),
            responses_relay_local_continuation: responses_relay_local_continuation.clone(),
            responses_relay_stopless_control: responses_relay_stopless_control.clone(),
            provider_health: provider_health.clone(),
            responses_direct_transport: responses_direct_transport.clone(),
        });
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
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
    if console_enabled {
        emit_v3_startup_console_line(&listeners);
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
        .route(
            "/_routecodex/diagnostics/virtual-router",
            get(virtual_router_status),
        )
        .route(
            "/_routecodex/diagnostics/virtual-router/status",
            get(virtual_router_status),
        )
        .route(
            "/_routecodex/diagnostics/virtual-router/dry-run",
            post(virtual_router_dry_run),
        )
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
    json_response(
        200,
        build_v3_models_catalog(&state.manifest, &state.server.routing_group),
    )
}

async fn virtual_router_status(
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

async fn virtual_router_dry_run(
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

async fn pending_endpoint(
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

fn is_provider_request_dry_run(headers: &HeaderMap) -> bool {
    headers
        .get("x-routecodex-dry-run")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("provider-request"))
}

fn merge_v3_protocol_plan_trace(
    mut plan_trace: Vec<&'static str>,
    runtime_trace: Vec<&'static str>,
) -> Vec<&'static str> {
    plan_trace.extend(runtime_trace);
    plan_trace
}

fn prepend_v3_protocol_plan_trace_to_foundation_output(
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

fn prepend_v3_protocol_plan_trace_to_responses_relay_output(
    output: &mut V3ResponsesRelayRuntimeOutput,
    plan_trace: &[&'static str],
) {
    output.node_trace =
        merge_v3_protocol_plan_trace(plan_trace.to_vec(), output.node_trace.clone());
}

fn allocate_v3_console_request_id(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<String, Box<Response<Body>>> {
    next_v3_console_request_id(state, endpoint, payload).map_err(|message| {
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

fn next_v3_console_request_id(
    state: &V3ListenerState,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<String, String> {
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
        .next_request_id(&entry, provider, &model)
}

async fn responses_websocket_endpoint(
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
async fn responses_websocket_session(
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

async fn handle_responses_websocket_message_with_mode(
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
    let request_id = match next_v3_console_request_id(state, "/v1/responses", Some(&payload)) {
        Ok(request_id) => request_id,
        Err(message) => {
            let body = json!({"error":{"type":"runtime_error","message":message}});
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","error":body["error"].clone()}).to_string(),
                ))
                .await;
            return Err(());
        }
    };
    let execution_id = state.debug.next_execution_id(&state.server.id);
    match execution_mode {
        V3EntryProtocolExecutionMode::Direct => {
            let frame = execute_responses_direct_server_frame(
                state,
                headers,
                "WEBSOCKET".to_string(),
                "/v1/responses".to_string(),
                request_id,
                execution_id,
                payload,
                None,
            )
            .await;
            send_responses_websocket_frame(socket, frame).await
        }
        V3EntryProtocolExecutionMode::Relay => {
            let output =
                execute_responses_relay_websocket_output(state, headers, request_id, payload).await;
            send_responses_relay_websocket_output(socket, output).await
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

async fn execute_responses_relay_websocket_output(
    state: &Arc<V3ListenerState>,
    headers: &HeaderMap,
    request_id: String,
    payload: Value,
) -> V3ResponsesRelayRuntimeOutput {
    let continuation_scope = match build_responses_relay_local_continuation_scope(
        headers,
        &request_id,
        &state.server,
        "/v1/responses",
        &payload,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            return project_v3_responses_relay_runtime_failure(
                V3ResponsesRelayRuntimeError::ProviderWireEncoding(message),
            );
        }
    };
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(error) => {
            return project_v3_responses_relay_runtime_failure(
                V3ResponsesRelayRuntimeError::ProviderWireEncoding(format!(
                    "system time precedes Unix epoch: {error}"
                )),
            );
        }
    };
    let transport = V3ResponsesRelayDefaultTransport::default();
    match execute_v3_responses_relay_runtime(
        &state.manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: state.server.id.clone(),
            request_id,
            payload,
        },
        build_responses_relay_execution_env(&state, &transport, continuation_scope, now_epoch_ms),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => project_v3_responses_relay_runtime_failure(error),
    }
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
                    .await;
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

async fn send_responses_relay_websocket_output(
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

async fn send_responses_relay_websocket_sse_stream(
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
    responses_protocol_plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> V3Server16HttpFrame {
    let requested_stream = v3_responses_request_wants_sse(request_headers, &payload);
    let continuation_scope = match build_responses_direct_continuation_scope(
        request_headers,
        &request_id,
        &state.server,
        &path,
        &payload,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            let frame = build_v3_server_16_http_frame_from_v3_error_06(project_http_input_error(
                V3HttpBoundaryErrorKind::MalformedJson,
                message,
            ));
            return project_v3_responses_direct_stream_error_frame_if_requested(
                frame,
                requested_stream,
            );
        }
    };
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(error) => {
            let frame =
                build_v3_server_16_http_frame_from_v3_foundation_output(project_v3_debug_failure(
                    "V3HubReqContinuation03Classified",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ));
            return project_v3_responses_direct_stream_error_frame_if_requested(
                frame,
                requested_stream,
            );
        }
    };
    let raw = build_v3_server_03_http_request_raw(
        state.server.id.clone(),
        request_id.clone(),
        execution_id.clone(),
        method,
        path,
        payload,
    );
    let env = V3ResponsesDirectExecutionEnv::new(
        register_responses_direct_hooks(),
        state.responses_direct_transport.as_ref(),
    )
    .with_debug(&state.debug)
    .with_shared_state_continuation(
        V3ResponsesDirectRuntimeSharedState::new(
            &state.responses_direct_continuation,
            state.provider_health.store(),
        ),
        continuation_scope,
        now_epoch_ms,
    );
    let output = match responses_protocol_plan {
        Some(plan) => {
            execute_v3_responses_direct_runtime_kernel(
                &state.manifest,
                raw,
                env.with_initial_plan(plan),
            )
            .await
        }
        None => execute_v3_responses_direct_runtime_kernel(&state.manifest, raw, env).await,
    };
    let scope = match state
        .debug
        .start_trace(&state.server.id, &request_id, &execution_id)
    {
        Ok(scope) => scope,
        Err(error) => {
            let frame = build_v3_server_16_http_frame_from_v3_foundation_output(
                project_v3_debug_failure("V3Debug01TraceContextStarted", error),
            );
            return project_v3_responses_direct_stream_error_frame_if_requested(
                frame,
                requested_stream,
            );
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
    let mut frame = build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    );
    frame.observability = output.observability;
    frame.stream_observation = output.stream_observation;
    project_v3_responses_direct_stream_error_frame_if_requested(frame, requested_stream)
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

struct V3ErrorProjectionConsoleInput<'input> {
    endpoint: &'input str,
    request_id: &'input str,
    status: u16,
    error_chain: &'input [&'static str],
    body: Option<&'input Value>,
    project_path: Option<&'input str>,
}

fn record_and_emit_v3_error_projection(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    input: V3ErrorProjectionConsoleInput<'_>,
) -> Option<Response<Body>> {
    if let Err(error) = state.debug.record_node_event(
        trace_scope,
        "V3Error06ClientProjected",
        "projected",
        Some(json!({
            "status": input.status,
            "error_chain": input.error_chain,
            "body": input.body
        })),
    ) {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3Error06ClientProjected",
            error,
        )));
    }
    emit_v3_error_console_line_for_state(
        state,
        input.endpoint,
        input.request_id,
        input.status,
        input.error_chain,
        input.body,
        input.project_path,
    );
    None
}

fn relay_error_body_for_console(body: &V3ResponsesRelayClientBody) -> Option<&Value> {
    match body {
        V3ResponsesRelayClientBody::Json(value) => Some(value),
        V3ResponsesRelayClientBody::Sse(_) => None,
    }
}

fn openai_chat_error_body_for_console(body: &V3OpenAiChatRelayClientBody) -> Option<&Value> {
    match body {
        V3OpenAiChatRelayClientBody::Json(value) => Some(value),
        V3OpenAiChatRelayClientBody::Sse(_) => None,
    }
}

fn gemini_error_body_for_console(body: &V3GeminiRelayClientBody) -> Option<&Value> {
    match body {
        V3GeminiRelayClientBody::Json(value) => Some(value),
        V3GeminiRelayClientBody::Sse(_) => None,
    }
}

fn request_accepts_sse(headers: &HeaderMap) -> bool {
    headers
        .get("accept")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("text/event-stream"))
        })
}

fn v3_responses_request_wants_sse(headers: &HeaderMap, payload: &Value) -> bool {
    payload.get("stream").and_then(Value::as_bool) == Some(true) || request_accepts_sse(headers)
}

fn response_input_item_count(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::Null) | None => 0,
        Some(Value::String(text)) if text.trim().is_empty() => 0,
        Some(_) => 1,
    }
}

fn build_responses_direct_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    payload: &Value,
) -> Result<V3ResponsesDirectContinuationScope, String> {
    let turn_metadata = parse_codex_turn_metadata(headers)?;
    let session_id = first_header_text(headers, &["session-id", "session_id", "x-session-id"])?
        .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_SESSION_PATHS))
        .or_else(|| read_first_scope_value(Some(payload), BODY_SESSION_PATHS));
    let conversation_id = first_header_text(
        headers,
        &[
            "thread-id",
            "thread_id",
            "conversation-id",
            "conversation_id",
            "x-conversation-id",
        ],
    )?
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    let (session_id, conversation_id) = resolve_transparent_continuation_scope(
        session_id,
        conversation_id,
        payload_needs_direct_continuation_scope(payload),
        request_id,
    )?;
    Ok(V3ResponsesDirectContinuationScope::responses(
        endpoint,
        session_id,
        conversation_id,
        server.port,
        server.routing_group.clone(),
    ))
}

fn build_responses_relay_execution_env<'a, T: V3ResponsesTransport>(
    state: &'a V3ListenerState,
    transport: &'a T,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> V3ResponsesRelayExecutionEnv<'a, T> {
    V3ResponsesRelayExecutionEnv::new(
        transport,
        V3ResponsesRelayHealthSource::Shared(&state.provider_health),
    )
    .with_local_stopless_control(V3ResponsesRelayLocalStoplessControlInput::new(
        &state.responses_relay_local_continuation,
        &state.responses_relay_stopless_control,
        scope,
        now_epoch_ms,
    ))
}

async fn execute_responses_relay_runtime_for_http_request<T: V3ResponsesTransport>(
    state: &V3ListenerState,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> V3ResponsesRelayRuntimeOutput {
    let mut env = build_responses_relay_execution_env(state, transport, scope, now_epoch_ms);
    if let Some(plan) = plan {
        env = env.with_initial_target(plan.decision.target.clone());
    }
    match execute_v3_responses_relay_runtime(&state.manifest, input, env).await {
        Ok(mut output) => {
            if let Some(plan) = plan {
                prepend_v3_protocol_plan_trace_to_responses_relay_output(
                    &mut output,
                    &plan.node_trace,
                );
            }
            output
        }
        Err(error) => project_v3_responses_relay_runtime_failure(error),
    }
}

fn build_responses_relay_local_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    payload: &Value,
) -> Result<V3ResponsesRelayLocalContinuationScope, String> {
    let turn_metadata = parse_codex_turn_metadata(headers)?;
    let session_id = first_header_text(headers, &["session-id", "session_id", "x-session-id"])?
        .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_SESSION_PATHS))
        .or_else(|| read_first_scope_value(Some(payload), BODY_SESSION_PATHS));
    let conversation_id = first_header_text(
        headers,
        &[
            "thread-id",
            "thread_id",
            "conversation-id",
            "conversation_id",
            "x-conversation-id",
        ],
    )?
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    let (session_id, conversation_id) = resolve_transparent_continuation_scope(
        session_id,
        conversation_id,
        payload_needs_relay_local_continuation_scope(payload),
        request_id,
    )?;
    Ok(V3ResponsesRelayLocalContinuationScope::responses(
        endpoint,
        session_id,
        conversation_id,
        server.port,
        server.routing_group.clone(),
    ))
}

fn build_responses_previous_response_owner_resolution_context(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    payload: &Value,
) -> Result<Option<V3ResponsesPreviousResponseOwnerResolutionContext>, String> {
    if payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Ok(None);
    }
    let direct_scope =
        build_responses_direct_continuation_scope(headers, request_id, server, endpoint, payload)?;
    let relay_scope = build_responses_relay_local_continuation_scope(
        headers, request_id, server, endpoint, payload,
    )?;
    let now_epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("system time precedes Unix epoch: {error}"))?
        .as_millis() as u64;
    Ok(Some(V3ResponsesPreviousResponseOwnerResolutionContext {
        direct_scope,
        relay_scope,
        now_epoch_ms,
    }))
}

fn resolve_transparent_continuation_scope(
    session_id: Option<String>,
    conversation_id: Option<String>,
    requires_client_scope: bool,
    request_id: &str,
) -> Result<(String, String), String> {
    match (session_id, conversation_id) {
        (Some(session_id), Some(conversation_id)) => Ok((session_id, conversation_id)),
        (None, None) if !requires_client_scope => {
            let request_scope = format!("request:{request_id}");
            Ok((request_scope.clone(), request_scope))
        }
        _ => Err(
            "Responses continuation requires client-provided session_id and thread_id via transparent headers, x-codex-turn-metadata, or body client_metadata"
                .to_string(),
        ),
    }
}

fn payload_needs_direct_continuation_scope(payload: &Value) -> bool {
    payload.get("previous_response_id").is_some()
        || payload_input_has_function_call_output(payload.get("input"))
}

fn payload_needs_relay_local_continuation_scope(payload: &Value) -> bool {
    payload.get("previous_response_id").is_some()
        || payload_input_has_unpaired_function_call_output(payload.get("input"))
}

fn payload_input_has_function_call_output(input: Option<&Value>) -> bool {
    match input {
        Some(Value::Array(items)) => items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("function_call_output")),
        Some(Value::Object(item)) => {
            item.get("type").and_then(Value::as_str) == Some("function_call_output")
        }
        _ => false,
    }
}

fn payload_input_has_unpaired_function_call_output(input: Option<&Value>) -> bool {
    let Some(input) = input else {
        return false;
    };
    let Some(items) = input.as_array() else {
        return input
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|item_type| {
                matches!(
                    item_type,
                    "function_call_output" | "custom_tool_call_output" | "tool_call_output"
                )
            });
    };
    let paired_call_ids: Vec<&str> = items
        .iter()
        .filter_map(|item| {
            let item_type = item.get("type").and_then(Value::as_str)?;
            if !matches!(
                item_type,
                "function_call" | "custom_tool_call" | "tool_call"
            ) {
                return None;
            }
            item.get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .collect();
    items.iter().any(|item| {
        let Some(item_type) = item.get("type").and_then(Value::as_str) else {
            return false;
        };
        if !matches!(
            item_type,
            "function_call_output" | "custom_tool_call_output" | "tool_call_output"
        ) {
            return false;
        }
        let Some(call_id) = item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return false;
        };
        !paired_call_ids.iter().any(|paired| paired == &call_id)
    })
}

const TURN_METADATA_SESSION_PATHS: &[&[&str]] = &[&["session_id"], &["sessionId"], &["session-id"]];

const TURN_METADATA_CONVERSATION_PATHS: &[&[&str]] = &[
    &["thread_id"],
    &["threadId"],
    &["thread-id"],
    &["conversation_id"],
    &["conversationId"],
    &["conversation-id"],
];

const TURN_METADATA_TMUX_PATHS: &[&[&str]] = &[
    &["clientTmuxSessionId"],
    &["client_tmux_session_id"],
    &["rccSessionClientTmuxSessionId"],
    &["rcc_session_client_tmux_session_id"],
    &["tmux_session"],
    &["tmuxSession"],
    &["tmuxSessionId"],
    &["tmux_session_id"],
    &["scope", "clientTmuxSessionId"],
    &["scope", "client_tmux_session_id"],
    &["scope", "rccSessionClientTmuxSessionId"],
    &["scope", "rcc_session_client_tmux_session_id"],
    &["scope", "tmux_session"],
    &["scope", "tmuxSession"],
    &["scope", "tmuxSessionId"],
    &["scope", "tmux_session_id"],
];

const TURN_METADATA_WORKDIR_PATHS: &[&[&str]] = &[
    &["workdir"],
    &["cwd"],
    &["workingDirectory"],
    &["working_directory"],
];

const BODY_SESSION_PATHS: &[&[&str]] = &[
    &["client_metadata", "session_id"],
    &["client_metadata", "sessionId"],
    &["client_metadata", "session-id"],
    &["clientMetadata", "session_id"],
    &["clientMetadata", "sessionId"],
    &["metadata", "session_id"],
    &["metadata", "sessionId"],
    &["metadata", "client_metadata", "session_id"],
    &["metadata", "client_metadata", "sessionId"],
    &["metadata", "clientMetadata", "session_id"],
    &["metadata", "clientMetadata", "sessionId"],
];

const BODY_WORKDIR_PATHS: &[&[&str]] = &[
    &["workdir"],
    &["cwd"],
    &["workingDirectory"],
    &["working_directory"],
    &["metadata", "workdir"],
    &["metadata", "cwd"],
    &["metadata", "workingDirectory"],
    &["metadata", "working_directory"],
];

const BODY_CONVERSATION_PATHS: &[&[&str]] = &[
    &["client_metadata", "thread_id"],
    &["client_metadata", "threadId"],
    &["client_metadata", "thread-id"],
    &["client_metadata", "conversation_id"],
    &["client_metadata", "conversationId"],
    &["client_metadata", "conversation-id"],
    &["clientMetadata", "thread_id"],
    &["clientMetadata", "threadId"],
    &["clientMetadata", "conversation_id"],
    &["clientMetadata", "conversationId"],
    &["metadata", "thread_id"],
    &["metadata", "threadId"],
    &["metadata", "conversation_id"],
    &["metadata", "conversationId"],
    &["metadata", "client_metadata", "thread_id"],
    &["metadata", "client_metadata", "threadId"],
    &["metadata", "client_metadata", "conversation_id"],
    &["metadata", "client_metadata", "conversationId"],
    &["metadata", "clientMetadata", "thread_id"],
    &["metadata", "clientMetadata", "threadId"],
    &["metadata", "clientMetadata", "conversation_id"],
    &["metadata", "clientMetadata", "conversationId"],
];

fn parse_codex_turn_metadata(headers: &HeaderMap) -> Result<Option<Value>, String> {
    let Some(text) = header_text(headers, "x-codex-turn-metadata")? else {
        return Ok(None);
    };
    let mut last_error = match serde_json::from_str::<Value>(&text) {
        Ok(value) => return Ok(Some(value)),
        Err(error) => error.to_string(),
    };
    if let Some(decoded) = percent_decode_header_value(&text)? {
        match serde_json::from_str::<Value>(&decoded) {
            Ok(value) => return Ok(Some(value)),
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!(
        "x-codex-turn-metadata is not valid JSON: {last_error}"
    ))
}

fn percent_decode_header_value(value: &str) -> Result<Option<String>, String> {
    if !value.as_bytes().contains(&b'%') {
        return Ok(None);
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err("x-codex-turn-metadata has incomplete percent escape".to_string());
        }
        let high = decode_hex(bytes[index + 1])
            .ok_or_else(|| "x-codex-turn-metadata has invalid percent escape".to_string())?;
        let low = decode_hex(bytes[index + 2])
            .ok_or_else(|| "x-codex-turn-metadata has invalid percent escape".to_string())?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).map(Some).map_err(|error| {
        format!("x-codex-turn-metadata percent-decoded value is not UTF-8: {error}")
    })
}

fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn first_header_text(headers: &HeaderMap, names: &[&str]) -> Result<Option<String>, String> {
    for name in names {
        if let Some(value) = header_text(headers, name)? {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn read_first_scope_value(source: Option<&Value>, paths: &[&[&str]]) -> Option<String> {
    for path in paths {
        if let Some(value) = read_scope_value_at_path(source?, path) {
            return Some(value);
        }
    }
    None
}

fn read_scope_value_at_path(source: &Value, path: &[&str]) -> Option<String> {
    let mut current = source;
    for segment in path {
        current = current.get(*segment)?;
    }
    let value = current.as_str()?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
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
    let transport = V3ResponsesRelayDefaultTransport::default();
    execute_v3_responses_relay_runtime(
        manifest,
        input,
        V3ResponsesRelayExecutionEnv::new(&transport, V3ResponsesRelayHealthSource::ManifestLocal),
    )
    .await
}

fn responses_relay_output_response(
    output: V3ResponsesRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
) -> Response<Body> {
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
        V3ResponsesRelayClientBody::Sse(client_stream) => v3_relay_client_sse_body(
            wrap_v3_relay_sse_console_stream(client_stream, stream_console_finalizer),
        ),
        V3ResponsesRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Responses Relay projection"),
        ),
    };
    builder
        .body(body)
        .expect("typed V3 Responses Relay response")
}

fn wrap_v3_relay_sse_console_stream(
    stream: V3ResponsesRelayClientStream,
    finalizer: Option<V3SseConsoleFinalizer>,
) -> V3ResponsesRelayClientStream {
    match finalizer {
        Some(finalizer) => {
            wrap_v3_relay_sse_closeout_stream(stream, move |terminal| match terminal {
                V3SseConsoleStreamTerminal::Completed => finalizer.complete(),
                V3SseConsoleStreamTerminal::Failed(error) => {
                    finalizer.provider_stream_failed(&error)
                }
                V3SseConsoleStreamTerminal::Dropped => finalizer.client_disconnected(),
            })
        }
        None => stream,
    }
}

struct V3SseConsoleCloseoutStream {
    stream: V3ResponsesRelayClientStream,
    closeout: Option<Box<dyn FnOnce(V3SseConsoleStreamTerminal) + Send>>,
}

impl V3SseConsoleCloseoutStream {
    fn emit_terminal(&mut self, terminal: V3SseConsoleStreamTerminal) {
        if let Some(closeout) = self.closeout.take() {
            closeout(terminal);
        }
    }
}

impl Unpin for V3SseConsoleCloseoutStream {}

impl futures_util::Stream for V3SseConsoleCloseoutStream {
    type Item = Result<Vec<u8>, String>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match this.stream.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => Poll::Ready(Some(Ok(chunk))),
            Poll::Ready(Some(Err(error))) => {
                this.emit_terminal(V3SseConsoleStreamTerminal::Failed(error.clone()));
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.emit_terminal(V3SseConsoleStreamTerminal::Completed);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for V3SseConsoleCloseoutStream {
    fn drop(&mut self) {
        self.emit_terminal(V3SseConsoleStreamTerminal::Dropped);
    }
}

fn wrap_v3_relay_sse_closeout_stream(
    stream: V3ResponsesRelayClientStream,
    closeout: impl FnOnce(V3SseConsoleStreamTerminal) + Send + 'static,
) -> V3ResponsesRelayClientStream {
    Box::pin(V3SseConsoleCloseoutStream {
        stream,
        closeout: Some(Box::new(closeout)),
    })
}

struct V3DirectSseConsoleCloseoutStream {
    stream: V3ClientSseStream,
    closeout: Option<Box<dyn FnOnce(V3SseConsoleStreamTerminal) + Send>>,
}

impl V3DirectSseConsoleCloseoutStream {
    fn emit_terminal(&mut self, terminal: V3SseConsoleStreamTerminal) {
        if let Some(closeout) = self.closeout.take() {
            closeout(terminal);
        }
    }
}

impl Unpin for V3DirectSseConsoleCloseoutStream {}

impl futures_util::Stream for V3DirectSseConsoleCloseoutStream {
    type Item = Result<Vec<u8>, routecodex_v3_error::V3Error01SourceRaised>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match this.stream.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => Poll::Ready(Some(Ok(chunk))),
            Poll::Ready(Some(Err(error))) => {
                this.emit_terminal(V3SseConsoleStreamTerminal::Failed(format!(
                    "{}: {}",
                    error.code, error.message
                )));
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.emit_terminal(V3SseConsoleStreamTerminal::Completed);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for V3DirectSseConsoleCloseoutStream {
    fn drop(&mut self) {
        self.emit_terminal(V3SseConsoleStreamTerminal::Dropped);
    }
}

fn wrap_v3_direct_sse_closeout_stream(
    stream: V3ClientSseStream,
    closeout: impl FnOnce(V3SseConsoleStreamTerminal) + Send + 'static,
) -> V3ClientSseStream {
    Box::pin(V3DirectSseConsoleCloseoutStream {
        stream,
        closeout: Some(Box::new(closeout)),
    })
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
    let decoded = build_v3_sse_transport_in_02_from_fields(vec![
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
    let validated = build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(decoded)
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&validated).into_bytes())
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
                .expect("typed response");
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

fn responses_direct_output_response(frame: V3Server16HttpFrame) -> Response<Body> {
    responses_direct_output_response_with_console(frame, None)
}

fn project_v3_responses_direct_stream_error_frame_if_requested(
    mut frame: V3Server16HttpFrame,
    requested_stream: bool,
) -> V3Server16HttpFrame {
    if !requested_stream || frame.error_chain.is_empty() || frame.content_type != "application/json"
    {
        return frame;
    }
    let body = match frame.body {
        V3Server16Body::Json(value) => value,
        other => {
            frame.body = other;
            return frame;
        }
    };
    let (code, message) = v3_error_body_code_message(&body);
    if frame.error_body.is_none() {
        frame.error_body = Some(body);
    }
    frame.content_type = "text/event-stream".to_string();
    frame.body = V3Server16Body::Sse(Box::pin(stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        v3_sse_error_event_chunk(frame.status, &code, &message),
    )])));
    frame
}

fn v3_error_body_code_message(body: &Value) -> (String, String) {
    let error = body.get("error").unwrap_or(body);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("runtime_error")
        .to_string();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("V3 Responses runtime error")
        .to_string();
    (code, message)
}

fn v3_sse_error_event_chunk(status: u16, code: &str, message: &str) -> Vec<u8> {
    let event = json!({
        "type": "error",
        "status": status,
        "error": {
            "code": code,
            "message": message
        }
    });
    format!("event: error\ndata: {event}\n\n").into_bytes()
}

fn responses_direct_output_response_with_console(
    frame: V3Server16HttpFrame,
    stream_console_finalizer: Option<V3DirectSseConsoleFinalizer>,
) -> Response<Body> {
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
            let stream = wrap_v3_direct_sse_console_stream(stream, stream_console_finalizer);
            return builder
                .body(v3_client_sse_body(stream))
                .expect("typed response");
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

fn wrap_v3_direct_sse_console_stream(
    stream: V3ClientSseStream,
    finalizer: Option<V3DirectSseConsoleFinalizer>,
) -> V3ClientSseStream {
    match finalizer {
        Some(finalizer) => {
            wrap_v3_direct_sse_closeout_stream(stream, move |terminal| match terminal {
                V3SseConsoleStreamTerminal::Completed => finalizer.complete(),
                V3SseConsoleStreamTerminal::Failed(error) => {
                    finalizer.provider_stream_failed(&error)
                }
                V3SseConsoleStreamTerminal::Dropped => finalizer.client_disconnected(),
            })
        }
        None => stream,
    }
}

fn v3_relay_client_sse_body(stream: V3ResponsesRelayClientStream) -> Body {
    Body::from_stream(stream::unfold(
        (stream, false),
        |(mut stream, done)| async move {
            if done {
                return None;
            }
            match stream.next().await {
                Some(Ok(chunk)) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
                Some(Err(error)) => Some((
                    Ok(v3_sse_error_event_chunk(
                        502,
                        "provider_response_sse_stream",
                        &error,
                    )),
                    (stream, true),
                )),
                None => None,
            }
        },
    ))
}

fn v3_client_sse_body(stream: V3ClientSseStream) -> Body {
    Body::from_stream(stream::unfold(
        (stream, false),
        |(mut stream, done)| async move {
            if done {
                return None;
            }
            match stream.next().await {
                Some(Ok(chunk)) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
                Some(Err(error)) => Some((
                    Ok(v3_sse_error_event_chunk(502, &error.code, &error.message)),
                    (stream, true),
                )),
                None => None,
            }
        },
    ))
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
    let error_body = match &payload.body {
        V3ClientBody::Json(value) if !error_chain.is_empty() => Some(value.clone()),
        V3ClientBody::Json(_) | V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => None,
    };
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
        error_body,
        node_trace,
        observability: None,
        stream_observation: None,
    }
}

// feature_id: v3.models_capability_catalog
fn build_v3_models_catalog(
    manifest: &V3Config05ManifestPublished,
    routing_group: &str,
) -> serde_json::Value {
    let mut data = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let scoped_models = collect_v3_route_group_catalog_model_refs(manifest, routing_group);
    if scoped_models
        .values()
        .any(|model_ref| model_ref.visible_id == "gpt-5.5" || model_ref.model_id == "gpt-5.5")
    {
        let builtin_model_id = "gpt-5.5";
        let capabilities = scoped_models
            .values()
            .filter(|model_ref| {
                model_ref.visible_id == builtin_model_id || model_ref.model_id == builtin_model_id
            })
            .flat_map(|model_ref| model_ref.capabilities.iter().cloned())
            .collect::<BTreeSet<_>>();
        let capabilities = if capabilities.is_empty() {
            default_builtin_v3_model_capabilities(builtin_model_id)
        } else {
            capabilities
        };
        let mut item = build_v3_codex_model_metadata(
            builtin_model_id,
            builtin_model_id,
            None,
            Some(&capabilities),
        );
        item.insert("owned_by".to_string(), json!("openai"));
        seen.insert(builtin_model_id.to_string());
        data.push(Value::Object(item));
    }
    for model_ref in scoped_models.values() {
        if is_v3_hidden_codex_future_model(&model_ref.visible_id)
            || is_v3_hidden_codex_future_model(&model_ref.model_id)
            || seen.contains(&model_ref.visible_id)
        {
            continue;
        }
        let Some(provider) = manifest.providers.get(&model_ref.provider_id) else {
            continue;
        };
        if !provider.enabled {
            continue;
        }
        let Some(model) = provider.models.get(&model_ref.model_id) else {
            continue;
        };
        let mut item = build_v3_codex_model_metadata(
            &model_ref.visible_id,
            &model.id,
            model.max_context_tokens,
            Some(&model_ref.capabilities),
        );
        item.insert(
            "owned_by".to_string(),
            json!(format!("provider:{}", provider.id)),
        );
        item.insert("provider_id".to_string(), json!(provider.id));
        item.insert("canonical_model_id".to_string(), json!(model.id));
        item.insert("wire_model".to_string(), json!(model.wire_name));
        item.insert("aliases".to_string(), json!(model.aliases));
        item.insert(
            "capabilities".to_string(),
            json!(model_ref.capabilities.iter().cloned().collect::<Vec<_>>()),
        );
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
        seen.insert(model_ref.visible_id.clone());
        data.push(Value::Object(item));
    }
    // Direct-routing surface: every enabled provider model is addressable as
    // `provider.model` regardless of route-group declarations, so expose those
    // ids alongside the routed catalog.
    for provider in manifest.providers.values() {
        if !provider.enabled {
            continue;
        }
        for model in provider.models.values() {
            let direct_id = format!("{}.{}", provider.id, model.id);
            if seen.contains(&direct_id) || is_v3_hidden_codex_future_model(&model.id) {
                continue;
            }
            let capabilities = model.capabilities.iter().cloned().collect::<BTreeSet<_>>();
            let mut item = build_v3_codex_model_metadata(
                &direct_id,
                &model.id,
                model.max_context_tokens,
                Some(&capabilities),
            );
            item.insert(
                "owned_by".to_string(),
                json!(format!("provider:{}", provider.id)),
            );
            item.insert("provider_id".to_string(), json!(provider.id));
            item.insert("canonical_model_id".to_string(), json!(model.id));
            item.insert("wire_model".to_string(), json!(model.wire_name));
            item.insert("direct_route".to_string(), json!(true));
            item.insert(
                "capabilities".to_string(),
                json!(model.capabilities.clone()),
            );
            item.insert(
                "supports_streaming".to_string(),
                json!(model.supports_streaming),
            );
            item.insert(
                "supports_thinking".to_string(),
                json!(model.supports_thinking),
            );
            item.insert("max_tokens".to_string(), json!(model.max_tokens));
            item.insert(
                "max_context_tokens".to_string(),
                json!(model.max_context_tokens),
            );
            seen.insert(direct_id);
            data.push(Value::Object(item));
        }
    }
    let models = data.clone();
    json!({
        "object": "list",
        "data": data,
        "models": models,
    })
}

fn is_v3_hidden_codex_future_model(model_id: &str) -> bool {
    let trimmed = model_id.trim();
    trimmed == "gpt-5.6" || trimmed.starts_with("gpt-5.6-")
}

struct V3ModelCapabilityProjection {
    input_modalities: Vec<&'static str>,
    supports_image_detail_original: bool,
    supports_search_tool: bool,
    web_search_tool_type: &'static str,
}

fn default_builtin_v3_model_capabilities(model_id: &str) -> BTreeSet<String> {
    let capabilities = match model_id {
        "gpt-5.5" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" => {
            ["text", "reasoning", "tools", "web_search", "multimodal"]
                .into_iter()
                .collect::<Vec<_>>()
        }
        _ => vec!["text"],
    };
    capabilities
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
}

fn build_v3_model_capability_projection(
    capabilities: Option<&BTreeSet<String>>,
    is_gpt_55: bool,
    is_gpt_56: bool,
) -> V3ModelCapabilityProjection {
    let owned_default;
    let capabilities = match capabilities {
        Some(capabilities) => capabilities,
        None => {
            owned_default = if is_gpt_55 {
                default_builtin_v3_model_capabilities("gpt-5.5")
            } else if is_gpt_56 {
                default_builtin_v3_model_capabilities("gpt-5.6-sol")
            } else {
                ["text"].into_iter().map(str::to_string).collect()
            };
            &owned_default
        }
    };
    let image_capable = capabilities.contains("multimodal") || capabilities.contains("vision");
    let supports_search_tool = capabilities.contains("web_search");
    let mut input_modalities = vec!["text"];
    if image_capable {
        input_modalities.push("image");
    }
    V3ModelCapabilityProjection {
        input_modalities,
        supports_image_detail_original: image_capable,
        supports_search_tool,
        web_search_tool_type: if image_capable {
            "text_and_image"
        } else {
            "text"
        },
    }
}

fn build_v3_codex_model_metadata(
    visible_id: &str,
    canonical_model_id: &str,
    max_context_tokens: Option<u64>,
    capabilities: Option<&BTreeSet<String>>,
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
    let capability_projection =
        build_v3_model_capability_projection(capabilities, is_gpt_55, is_gpt_56);
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
        (
            "web_search_tool_type".to_string(),
            json!(capability_projection.web_search_tool_type),
        ),
        (
            "supports_search_tool".to_string(),
            json!(capability_projection.supports_search_tool),
        ),
        (
            "input_modalities".to_string(),
            json!(capability_projection.input_modalities),
        ),
        (
            "supports_image_detail_original".to_string(),
            json!(capability_projection.supports_image_detail_original),
        ),
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
            // Codex currently consumes this field for recognized experimental tool names such as
            // `test_sync_tool`; `apply_patch` and search are controlled by `apply_patch_tool_type`
            // and `supports_search_tool`, not by this vector.
            json!(Vec::<&str>::new()),
        ),
        ("effective_context_window_percent".to_string(), json!(95)),
        ("context_window".to_string(), json!(context_window)),
        ("max_context_window".to_string(), json!(context_window)),
    ]);
    // Codex treats `tool_mode` and `use_responses_lite` as request/tool-surface selectors.
    // `gpt-5.5` must not advertise them: current Codex then keeps first-class tools such as
    // tool_search instead of forcing nested code-mode `exec`/`wait` entrypoints.
    if is_gpt_56 {
        item.insert("tool_mode".to_string(), json!("code_mode_only"));
        item.insert("use_responses_lite".to_string(), json!(true));
    }
    item
}

pub fn build_v3_server_16_http_frame_from_v3_error_06(
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> V3Server16HttpFrame {
    let body = projected.body;
    V3Server16HttpFrame {
        status: projected.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(body.clone()),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        error_body: Some(body),
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    }
}

pub fn build_v3_server_16_http_frame_from_v3_foundation_output(
    output: V3FoundationRuntimeOutput,
) -> V3Server16HttpFrame {
    let error_body = if output.error_chain.is_empty() {
        None
    } else {
        Some(output.body.clone())
    };
    V3Server16HttpFrame {
        status: output.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(output.body),
        debug_node: output.debug_node,
        error_node: output.error_node,
        error_chain: output.error_chain,
        error_body,
        node_trace: output.node_trace,
        observability: None,
        stream_observation: None,
    }
}

fn build_v3_debug_runtime_from_manifest(
    manifest: &V3DebugManifest,
) -> Result<V3DebugRuntime, routecodex_v3_debug::V3DebugError> {
    V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: manifest.log_console,
        log_file: manifest.log_file.clone(),
        snapshots_enabled: manifest.snapshots,
        snapshot_stages: manifest.snapshot_stages.clone(),
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
    let content_length = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
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
        let content_length = content_length
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        project_http_input_error(
            V3HttpBoundaryErrorKind::MalformedJson,
            format!(
                "malformed JSON request body: {error}; body_bytes={} content_length={content_length}",
                bytes.len()
            ),
        )
    })
}

async fn method_not_allowed(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let path = request.uri().path().to_string();
    let request_id = match allocate_v3_console_request_id(&state, &path, None) {
        Ok(request_id) => request_id,
        Err(response) => return *response,
    };
    error_output_response_for_server(
        &state.server,
        &path,
        &request_id,
        project_http_input_error(
            V3HttpBoundaryErrorKind::MethodNotAllowed,
            "HTTP method is not allowed for this endpoint",
        ),
    )
}

async fn path_not_found(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let path = request.uri().path().to_string();
    let request_id = match allocate_v3_console_request_id(&state, &path, None) {
        Ok(request_id) => request_id,
        Err(response) => return *response,
    };
    error_output_response_for_server(
        &state.server,
        &path,
        &request_id,
        project_http_input_error(
            V3HttpBoundaryErrorKind::PathNotFound,
            "HTTP path is not registered",
        ),
    )
}

fn project_http_input_error(
    kind: V3HttpBoundaryErrorKind,
    message: impl Into<String>,
) -> routecodex_v3_error::V3Error06ClientProjected {
    project_v3_http_boundary_error(kind, message)
}

fn error_output_response_for_server(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> Response<Body> {
    error_output_response_for_server_with_project_path(
        server, endpoint, request_id, projected, None,
    )
}

fn error_output_response_for_server_with_project_path(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
    project_path: Option<&str>,
) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
    emit_v3_frame_error_console_line(server, endpoint, request_id, &frame, project_path);
    responses_direct_output_response(frame)
}

fn error_output_response_for_responses_request_with_project_path(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
    request_headers: &HeaderMap,
    payload: Option<&Value>,
    project_path: Option<&str>,
) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
    emit_v3_frame_error_console_line(server, endpoint, request_id, &frame, project_path);
    responses_direct_output_response(project_v3_responses_error_frame_for_request_if_sse(
        frame,
        request_headers,
        payload,
    ))
}

fn project_v3_responses_error_frame_for_request_if_sse(
    frame: V3Server16HttpFrame,
    request_headers: &HeaderMap,
    payload: Option<&Value>,
) -> V3Server16HttpFrame {
    let requested_stream = payload
        .and_then(|payload| payload.get("stream"))
        .and_then(Value::as_bool)
        == Some(true)
        || request_accepts_sse(request_headers);
    project_v3_responses_direct_stream_error_frame_if_requested(frame, requested_stream)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex as StdMutex;

    static TEST_TZ_LOCK: StdMutex<()> = StdMutex::new(());

    unsafe extern "C" {
        fn tzset();
    }

    struct TestTzGuard {
        previous_tz: Option<std::ffi::OsString>,
    }

    impl TestTzGuard {
        fn set(value: &str) -> Self {
            let previous_tz = std::env::var_os("TZ");
            std::env::set_var("TZ", value);
            unsafe {
                tzset();
            }
            Self { previous_tz }
        }
    }

    impl Drop for TestTzGuard {
        fn drop(&mut self) {
            if let Some(previous_tz) = self.previous_tz.take() {
                std::env::set_var("TZ", previous_tz);
            } else {
                std::env::remove_var("TZ");
            }
            unsafe {
                tzset();
            }
        }
    }

    fn strip_test_ansi(input: &str) -> String {
        let mut output = String::new();
        let mut chars = input.chars();
        while let Some(character) = chars.next() {
            if character == '\x1b' {
                for next in chars.by_ref() {
                    if next == 'm' {
                        break;
                    }
                }
            } else {
                output.push(character);
            }
        }
        output
    }

    fn test_v3_console_log_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "routecodex-v3-{name}-{}-{}.log",
            std::process::id(),
            console_timestamp_hhmmss()
        ))
    }

    fn test_v3_listener_state(log_file: &std::path::Path, port: u16) -> Arc<V3ListenerState> {
        let mut servers = BTreeMap::new();
        let server = V3ServerManifest {
            id: format!("server-{port}"),
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port,
            routing_group: "controlled".to_string(),
            endpoints: vec!["responses".to_string()],
            features: BTreeMap::new(),
            execution: None,
        };
        servers.insert(server.id.clone(), server.clone());
        let manifest = Arc::new(V3Config05ManifestPublished {
            version: 3,
            hub_v1: None,
            servers,
            providers: BTreeMap::new(),
            forwarders: BTreeMap::new(),
            route_groups: BTreeMap::new(),
            features: BTreeMap::new(),
            debug: V3DebugManifest {
                log_console: false,
                log_file: Some(log_file.to_string_lossy().to_string()),
                snapshots: false,
                snapshot_stages: None,
                dry_run: false,
                retention: BTreeMap::new(),
            },
            error: routecodex_v3_config::V3ErrorManifest {
                policies: BTreeMap::new(),
                provider_error_action_policy: Vec::new(),
                client_error_projection_policy: Vec::new(),
            },
        });
        let debug = build_v3_debug_runtime_from_manifest(&manifest.debug).unwrap();
        Arc::new(V3ListenerState {
            server,
            manifest_version: manifest.version,
            manifest: Arc::clone(&manifest),
            debug,
            console_enabled: true,
            request_counter: Arc::new(Mutex::new(V3RequestIdCounter::new())),
            responses_direct_continuation: Arc::new(V3ResponsesDirectContinuationState::default()),
            responses_relay_local_continuation: Arc::new(
                V3ResponsesRelayLocalContinuationState::default(),
            ),
            responses_relay_stopless_control: Arc::new(
                V3ResponsesRelayStoplessControlState::default(),
            ),
            provider_health: Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
                &manifest,
            )),
            responses_direct_transport: Arc::new(V3ResponsesRelayDefaultTransport::default()),
        })
    }

    fn test_direct_console_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-routecodex-session-id",
            HeaderValue::from_static("direct-console-test"),
        );
        headers.insert(
            "x-routecodex-workdir",
            HeaderValue::from_static("/tmp/rules"),
        );
        headers
    }

    fn test_direct_observability(
        provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    ) -> V3RuntimeObservability {
        V3RuntimeObservability {
            entry_protocol: "responses".to_string(),
            execution_mode: "direct".to_string(),
            transport: "json".to_string(),
            routing_group_id: Some("coding".to_string()),
            pool_id: Some("direct".to_string()),
            provider_id: Some("second".to_string()),
            auth_alias: Some("key".to_string()),
            provider_key: Some("second:key:gpt-5.5".to_string()),
            provider_type: Some("openai-responses".to_string()),
            model_id: Some("gpt-5.5".to_string()),
            wire_model: Some("gpt-5.5".to_string()),
            provider_status: Some(200),
            response_status: Some("completed".to_string()),
            finish_reason: Some("stop".to_string()),
            stopless_activation: false,
            attempts: Some(2),
            unavailable_candidates: Vec::new(),
            provider_failure_events,
            target_path: vec!["direct".to_string(), "second".to_string()],
            usage: Some(V3RuntimeUsageSummary {
                input_tokens: Some(10),
                output_tokens: Some(2),
                total_tokens: Some(12),
                cached_tokens: Some(5),
            }),
        }
    }

    fn test_runtime_stream_observation_from_provider_event_json(
        event: Value,
    ) -> V3RuntimeStreamObservation {
        let observation = V3RuntimeStreamObservation::default();
        observation
            .record_provider_event_json(&event)
            .expect("test provider event JSON observation must record");
        observation
    }

    #[test]
    fn usage_summary_prints_cache_hit_rate() {
        let summary = V3RuntimeUsageSummary {
            input_tokens: Some(59_842),
            output_tokens: Some(822),
            total_tokens: Some(60_664),
            cached_tokens: Some(41_984),
        };
        assert_eq!(
            format_v3_console_usage_summary(Some(&summary)),
            "usage_in=59842 usage_out=822 usage_cache=41984/59842(70.2%) usage_total=60664"
        );
    }

    #[test]
    fn usage_summary_extracts_cached_read_hit_tokens() {
        let summary = extract_v3_console_usage_summary(&json!({
            "usage": {
                "input_tokens": 59_842,
                "input_tokens_details": {
                    "cached_read_tokens": 41_984,
                    "cached_write_tokens": 7
                },
                "output_tokens": 822,
                "total_tokens": 60_664
            }
        }))
        .expect("usage summary");
        assert_eq!(summary.cached_tokens, Some(41_984));
        assert_eq!(
            format_v3_console_usage_summary(Some(&summary)),
            "usage_in=59842 usage_out=822 usage_cache=41984/59842(70.2%) usage_total=60664"
        );
    }

    fn format_v3_console_project_port(project_path: Option<&str>, port: u16) -> String {
        format!("{}:{port}", format_v3_console_project_name(project_path))
    }

    #[test]
    fn console_project_path_reads_codex_environment_context_cwd() {
        let payload = json!({
            "model":"gpt-5.5",
            "client_metadata": {
                "x-codex-turn-metadata": "{\"workspaces\":{\"/Volumes/extension/code\":{\"associated_remote_urls\":{\"origin\":\"https://github.com/Jasonzhangf/OneStop.git\"}}}}"
            },
            "input": [{
                "type":"message",
                "role":"user",
                "content": [{
                    "type":"input_text",
                    "text":"<environment_context>\n  <cwd>/Volumes/extension/code/OneStop</cwd>\n  <shell>zsh</shell>\n  <filesystem><workspace_roots><root>/Volumes/extension/code/OneStop</root></workspace_roots></filesystem>\n</environment_context>"
                }]
            }]
        });
        let headers = HeaderMap::new();

        assert_eq!(
            resolve_v3_console_project_path(&headers, &payload).as_deref(),
            Some("/Volumes/extension/code/OneStop")
        );
        assert_eq!(
            format_v3_console_monitor_prefix(
                "5555",
                "/v1/responses",
                resolve_v3_console_project_path(&headers, &payload).as_deref()
            ),
            format!(
                "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}]",
                "OneStop", "-", "-"
            )
        );
    }

    #[test]
    fn request_id_tokens_are_stable_and_path_safe() {
        assert_eq!(
            format_v3_request_id_entry("/v1/responses"),
            "openai-responses"
        );
        assert_eq!(format_v3_request_id_token("GPT-5.5 / SOL:β"), "GPT-5.5SOL");
    }

    #[test]
    fn v3_console_v2_usage_request_id_and_project_helpers_are_stable() {
        assert_eq!(
            format_v3_usage_request_id("openai-responses-router-test-20260721T000000000-12-3"),
            "12-3"
        );
        assert_eq!(format_v3_usage_request_id("req_123_456"), "123-456");
        assert_eq!(format_v3_usage_request_id("abcdef123456"), "ef123456");
        assert_eq!(
            format_v3_console_project_port(
                Some("/Users/fanzhang/Documents/github/routecodex"),
                5555
            ),
            "routecodex:5555"
        );
    }

    #[test]
    fn console_scoped_prefix_is_compact_project_model_route_shape() {
        assert_eq!(
            format_v3_console_scoped_prefix(
                "5520",
                "responses",
                "xxxx",
                Some("/Users/fanzhang/Documents/github/rules"),
                "cc.gpt-5.5",
                "thinking",
            ),
            format!(
                "[5520:responses:sessionID:xxxx][{:<12}][{:<28}][{:<13}]",
                "rules", "cc.gpt-5.5", "thinking"
            )
        );
    }

    #[test]
    fn console_scoped_line_aligns_project_model_route_and_content_columns() {
        let short = format_v3_console_scoped_line(
            "5520",
            "responses",
            "xxxx",
            Some("/Users/fanzhang/Documents/github/rules"),
            "cc.gpt-5.5",
            "thinking",
            "▶ [/v1/responses] req=a",
        );
        let long = format_v3_console_scoped_line(
            "5520",
            "responses",
            "xxxx",
            Some("/Volumes/extension/code/OneStop"),
            "glmrelay_openai.glm-5.2",
            "longcontext",
            "▶ [/v1/responses] req=b",
        );
        assert_eq!(
            short.find(" ▶ [/v1/responses]"),
            long.find(" ▶ [/v1/responses]"),
            "content column must stay aligned for normal project/model/route data: short={short:?} long={long:?}"
        );
    }

    #[test]
    fn console_timed_content_aligns_tags_by_terminal_display_width() {
        assert_eq!(v3_console_char_display_width('▶'), 1);
        assert_eq!(v3_console_char_display_width('✅'), 2);
        assert_eq!(v3_console_char_display_width('❌'), 2);
        assert_eq!(v3_console_char_display_width('🧭'), 2);

        let started = format_v3_console_timed_content("▶ [/v1/responses]", "req=a");
        let completed = format_v3_console_timed_content("✅ [/v1/responses]", "req=b");
        let failed = format_v3_console_timed_content("❌ [provider-error]", "req=e");
        let stopless = format_v3_console_timed_content("🧭 [stopless]", "req=c");
        let usage = format_v3_console_timed_content("[usage]", "req=d");

        let data_columns = [&started, &completed, &failed, &stopless, &usage].map(|line| {
            let boundary = line.find(" req=").expect("timed content must contain req");
            v3_console_display_width(&line[..boundary])
        });
        assert!(
            data_columns.windows(2).all(|pair| pair[0] == pair[1]),
            "timed content data columns must align by terminal display width: {data_columns:?}"
        );
    }

    #[test]
    fn request_console_color_marks_scope_and_finish_reason_values_white() {
        let previous = std::env::var_os("ROUTECODEX_FORCE_LOG_COLOR");
        std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", "1");
        let colored = colorize_v3_request_console_line(
            "[5520:responses:sessionID:xxxx][rules][cc.gpt-5.5][thinking] [usage] req=622580-3466 finish_reason=tool_calls",
            Some("xxxx"),
        );
        if let Some(previous) = previous {
            std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", previous);
        } else {
            std::env::remove_var("ROUTECODEX_FORCE_LOG_COLOR");
        }
        assert!(colored.contains(&format!("{ANSI_WHITE}5520{ANSI_RESET}")));
        assert!(colored.contains(&format!("{ANSI_WHITE}xxxx{ANSI_RESET}")));
        assert!(colored.contains(&format!("{ANSI_WHITE}rules{ANSI_RESET}")));
        assert!(colored.contains(&format!("{ANSI_WHITE}cc.gpt-5.5{ANSI_RESET}")));
        assert!(colored.contains(&format!("{ANSI_WHITE}thinking{ANSI_RESET}")));
        assert!(colored.contains(&format!("{ANSI_WHITE}622580-3466{ANSI_RESET}")));
        assert!(colored.contains(&format!("{ANSI_WHITE}tool_calls{ANSI_RESET}")));
        assert!(colored.contains("responses"));
        assert!(colored.contains("finish_reason="));
    }

    #[test]
    fn console_timestamp_uses_local_timezone() {
        let _guard = TEST_TZ_LOCK.lock().unwrap();
        let _tz = TestTzGuard::set("Asia/Shanghai");
        let clock = super::request_id::v3_request_id_clock_now().unwrap();
        let local_hhmmss = clock.local_timestamp.get(9..15).unwrap();
        let expected = format!(
            "{}:{}:{}",
            &local_hhmmss[0..2],
            &local_hhmmss[2..4],
            &local_hhmmss[4..6]
        );
        assert_eq!(console_timestamp_hhmmss(), expected);
    }

    #[test]
    fn console_prefix_orders_port_entry_cwd_before_content() {
        assert_eq!(format_v3_console_project_port(None, 5555), "-:5555");
        let line = format_v3_error_console_line_with_port(
            "5555",
            "responses",
            "req-prefix",
            500,
            &V3_ERROR_CHAIN_NODE_IDS,
            Some(&json!({
                "error": {
                    "type": "runtime_error",
                    "message": "controlled"
                }
            })),
            None,
        );
        assert!(
            line.starts_with(&format!(
                "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}] ",
                "-", "-", "-"
            )),
            "console prefix must be scoped port/protocol/session/project/model/route before content: {line}"
        );
        assert!(line.contains("❌ [responses]"));
        assert!(line.contains("req=req-prefix event=failed"));
    }

    #[test]
    fn malformed_json_error_console_uses_header_project_path_not_server_cwd() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-routecodex-workdir",
            HeaderValue::from_static("/Volumes/extension/code/OneStop"),
        );
        let line = format_v3_error_console_line_with_port(
            "5555",
            "responses",
            "req-malformed",
            400,
            &V3_ERROR_CHAIN_NODE_IDS,
            Some(&json!({
                "error": {
                    "code": "malformed_json",
                    "message": "malformed JSON request body"
                }
            })),
            resolve_v3_console_project_path(&headers, &Value::Null).as_deref(),
        );

        assert!(
            line.starts_with(&format!(
                "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}] ",
                "OneStop", "-", "-"
            )),
            "malformed request line must preserve compact header project scope: {line}"
        );
    }

    #[tokio::test]
    async fn malformed_json_error_includes_body_length_without_raw_payload() {
        let request = Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .header(CONTENT_TYPE, "application/json")
            .header(CONTENT_LENGTH, "27")
            .body(Body::from(r#"{"model":"gpt-5.5","input":"#))
            .unwrap();

        let projected = read_json_payload(request)
            .await
            .expect_err("truncated JSON must fail at the HTTP boundary");

        assert_eq!(projected.status, 400);
        assert_eq!(projected.body["error"]["code"], "malformed_json");
        let message = projected.body["error"]["message"].as_str().unwrap();
        assert!(message.contains("malformed JSON request body"));
        assert!(message.contains("EOF"));
        assert!(message.contains("body_bytes=27"));
        assert!(message.contains("content_length=27"));
        assert!(
            !message.contains("gpt-5.5") && !message.contains("input"),
            "malformed JSON diagnostics must not echo raw client payload: {message}"
        );
    }

    #[test]
    fn error_console_prefix_can_preserve_request_project_path() {
        let line = format_v3_error_console_line_with_port(
            "5555",
            "responses",
            "req-project-cwd",
            500,
            &V3_ERROR_CHAIN_NODE_IDS,
            Some(&json!({
                "error": {
                    "type": "runtime_error",
                    "message": "controlled"
                }
            })),
            Some("/Volumes/extension/code/OneStop"),
        );
        assert!(
            line.starts_with(&format!(
                "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}] ",
                "OneStop", "-", "-"
            )),
            "failed request line must preserve compact request project scope: {line}"
        );
        assert!(line.contains("req=req-project-cwd event=failed"));
    }

    #[test]
    fn v3_console_v2_provider_target_uses_auth_alias_and_wire_model() {
        let observability = V3RuntimeObservability {
            provider_id: Some("test".to_string()),
            auth_alias: Some("key".to_string()),
            model_id: Some("test".to_string()),
            wire_model: Some("wire-test".to_string()),
            ..Default::default()
        };
        assert_eq!(
            format_v3_console_provider_target(&observability),
            "test[key].wire-test"
        );
    }

    #[test]
    fn provider_failure_console_content_exposes_red_error_and_switch() {
        let event = V3RuntimeProviderFailureObservation {
            provider_key: "limited:key1:gpt-5.5".to_string(),
            provider_id: "limited".to_string(),
            auth_alias: Some("key1".to_string()),
            model_id: "gpt-5.5".to_string(),
            status: 502,
            error_type: Some("provider_error".to_string()),
            external_error_kind: Some("transport".to_string()),
            external_error_code: Some("TRANSPORT_ERROR".to_string()),
            external_error_status: None,
            internal_code: None,
            message: "provider response event codec failed".to_string(),
            failure_count: 3,
            health_state: "cooldown".to_string(),
            cooldown_until_ms: Some(903_000),
            action: "switch_provider".to_string(),
            next_provider_key: Some("minimax:key1:MiniMax-M3".to_string()),
            wait_ms: None,
        };
        let error_content =
            format_v3_provider_failure_console_content("req-provider-switch", &event);
        assert!(error_content.contains("❌ [provider-error]"));
        assert!(error_content.contains("provider=limited[key1].gpt-5.5"));
        assert!(error_content.contains("failures=3"));
        assert!(error_content.contains("health=cooldown"));
        assert!(error_content.contains("next=minimax[key1].MiniMax-M3"));
        assert!(error_content.contains("external=transport"));
        assert!(error_content.contains("externalCode=TRANSPORT_ERROR"));
        let switch_content =
            format_v3_provider_switch_console_content("req-provider-switch", &event);
        assert!(switch_content.contains("[provider-switch]"));
        assert!(switch_content.contains("from=limited[key1].gpt-5.5 to=minimax[key1].MiniMax-M3"));

        let previous = std::env::var_os("ROUTECODEX_FORCE_LOG_COLOR");
        std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", "1");
        let colored = colorize_v3_error_console_line(&error_content);
        if let Some(previous) = previous {
            std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", previous);
        } else {
            std::env::remove_var("ROUTECODEX_FORCE_LOG_COLOR");
        }
        assert!(
            colored.starts_with(ANSI_ERROR_RED),
            "provider error console line must be red: {colored:?}"
        );
    }

    #[test]
    fn direct_frame_console_emits_provider_switch_complete_and_usage() {
        let log_file = test_v3_console_log_file("direct-console-json");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-json",
            &headers,
            &json!({"model":"gpt-5.5"}),
        );
        let provider_failure = V3RuntimeProviderFailureObservation {
            provider_key: "first:key:gpt-5.5".to_string(),
            provider_id: "first".to_string(),
            auth_alias: Some("key".to_string()),
            model_id: "gpt-5.5".to_string(),
            status: 502,
            error_type: Some("provider_error".to_string()),
            external_error_kind: None,
            external_error_code: None,
            external_error_status: None,
            internal_code: None,
            message: "upstream failed once".to_string(),
            failure_count: 1,
            health_state: "healthy".to_string(),
            cooldown_until_ms: None,
            action: "switch_provider".to_string(),
            next_provider_key: Some("second:key:gpt-5.5".to_string()),
            wait_ms: None,
        };
        let frame = V3Server16HttpFrame {
            status: 200,
            content_type: "application/json".to_string(),
            body: V3Server16Body::Json(json!({
                "status": "completed",
                "finish_reason": "stop",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 2,
                    "total_tokens": 12,
                    "cached_tokens": 5
                }
            })),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(test_direct_observability(vec![provider_failure])),
            stream_observation: None,
        };

        assert!(emit_v3_direct_frame_console_lines(&context, &frame, Instant::now()).is_none());

        let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
        assert!(
            log.contains("▶ [/v1/responses]")
                && log.contains("[second.gpt-5.5")
                && !log.contains("[gpt-5.5")
                && !log.contains("[pending")
                && log.contains("❌ [provider-error]")
                && log.contains("[provider-switch]")
                && log.contains("[virtual-router-hit]")
                && log.contains("event=completed")
                && log.contains("[usage]")
                && log.contains("req=req-direct-console-json"),
            "direct JSON console must emit start/route/terminal lines from pipeline observability provider.model, not request model or pre-route pending scope: {log}"
        );
        let _ = std::fs::remove_file(&log_file);
    }

    #[test]
    fn direct_frame_console_infers_stop_finish_reason_from_completed_json_status() {
        let log_file = test_v3_console_log_file("direct-console-json-infer-finish");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-json-infer-finish",
            &headers,
            &json!({"model":"gpt-5.5"}),
        );
        let frame = V3Server16HttpFrame {
            status: 200,
            content_type: "application/json".to_string(),
            body: V3Server16Body::Json(json!({
                "status": "completed",
                "usage": {
                    "input_tokens": 41,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens": 38,
                    "total_tokens": 79
                }
            })),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(V3RuntimeObservability {
                response_status: None,
                finish_reason: None,
                usage: None,
                ..test_direct_observability(Vec::new())
            }),
            stream_observation: None,
        };

        assert!(emit_v3_direct_frame_console_lines(&context, &frame, Instant::now()).is_none());

        let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
        assert!(log.contains("event=completed"), "{log}");
        assert!(log.contains("responseStatus=completed"), "{log}");
        assert!(log.contains("finish_reason=stop"), "{log}");
        assert!(log.contains("usage_in=41 usage_out=38"), "{log}");
        assert!(log.contains("usage_total=79"), "{log}");
        assert!(!log.contains("finish_reason=unreported"), "{log}");
        let _ = std::fs::remove_file(&log_file);
    }

    #[tokio::test]
    async fn direct_sse_console_closeout_fails_when_terminal_success_missing() {
        let log_file = test_v3_console_log_file("direct-console-sse-complete");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-sse",
            &headers,
            &json!({"model":"gpt-5.5","stream":true}),
        );
        let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Ok::<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n".to_vec(),
        )]));
        let frame = V3Server16HttpFrame {
            status: 200,
            content_type: "text/event-stream".to_string(),
            body: V3Server16Body::Sse(stream),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(V3RuntimeObservability {
                transport: "sse".to_string(),
                response_status: Some("streaming".to_string()),
                finish_reason: None,
                usage: None,
                ..test_direct_observability(Vec::new())
            }),
            stream_observation: None,
        };
        let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
        let response = responses_direct_output_response_with_console(frame, finalizer);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(std::str::from_utf8(&bytes)
            .unwrap()
            .contains("response.failed"));

        let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
        assert!(
            log.contains("[virtual-router-hit]")
                && log.contains("event=failed")
                && log.contains("status=502")
                && log.contains("subcode=provider_response_sse_stream")
                && log.contains("provider response SSE stream ended before terminal event")
                && !log.contains("event=completed"),
            "direct SSE closeout must not synthesize success when runtime observation has no terminal success: {log}"
        );
        let _ = std::fs::remove_file(&log_file);
    }

    #[tokio::test]
    async fn direct_sse_console_closeout_uses_runtime_stream_observation_for_usage_and_finish() {
        let log_file = test_v3_console_log_file("direct-console-sse-observed-usage");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-sse-observed",
            &headers,
            &json!({"model":"gpt-5.5","stream":true}),
        );
        let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Ok::<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":17,\"input_tokens_details\":{\"cached_tokens\":5},\"output_tokens\":3,\"total_tokens\":20}}}\n\ndata: [DONE]\n\n".to_vec(),
        )]));
        let frame = V3Server16HttpFrame {
            status: 200,
            content_type: "text/event-stream".to_string(),
            body: V3Server16Body::Sse(stream),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(V3RuntimeObservability {
                transport: "sse".to_string(),
                response_status: Some("streaming".to_string()),
                finish_reason: None,
                usage: None,
                ..test_direct_observability(Vec::new())
            }),
            stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
                json!({
                    "type":"response.completed",
                    "response":{
                        "status":"completed",
                        "usage":{
                            "input_tokens":17,
                            "input_tokens_details":{"cached_tokens":5},
                            "output_tokens":3,
                            "total_tokens":20
                        }
                    }
                }),
            )),
        };
        let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
        let response = responses_direct_output_response_with_console(frame, finalizer);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(std::str::from_utf8(&bytes)
            .unwrap()
            .contains("response.completed"));

        let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
        assert!(log.contains("event=completed"), "{log}");
        assert!(log.contains("responseStatus=completed"), "{log}");
        assert!(log.contains("finish_reason=stop"), "{log}");
        assert!(log.contains("usage_in=17 usage_out=3"), "{log}");
        assert!(log.contains("usage_cache=5/17(29.4%)"), "{log}");
        assert!(log.contains("usage_total=20"), "{log}");
        assert!(!log.contains("usage=unreported"), "{log}");
        assert!(!log.contains("finish_reason=unreported"), "{log}");
        let _ = std::fs::remove_file(&log_file);
    }

    #[tokio::test]
    async fn direct_sse_console_closeout_treats_drop_after_observed_completed_as_complete() {
        let log_file = test_v3_console_log_file("direct-console-sse-drop-after-completed");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-sse-drop-completed",
            &headers,
            &json!({"model":"gpt-5.5","stream":true}),
        );
        let provider = stream::iter(vec![Ok::<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
        )])
        .chain(stream::pending::<Result<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >>());
        let frame = V3Server16HttpFrame {
            status: 201,
            content_type: "text/event-stream".to_string(),
            body: V3Server16Body::Sse(Box::pin(provider)),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(V3RuntimeObservability {
                transport: "sse".to_string(),
                response_status: Some("streaming".to_string()),
                finish_reason: None,
                usage: None,
                ..test_direct_observability(Vec::new())
            }),
            stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
                json!({"type":"response.completed","response":{"status":"completed"}}),
            )),
        };
        let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
        let mut stream = wrap_v3_direct_sse_console_stream(
            match frame.body {
                V3Server16Body::Sse(stream) => stream,
                _ => unreachable!("test frame owns SSE body"),
            },
            finalizer,
        );
        let chunk = stream.next().await.unwrap().unwrap();
        assert!(std::str::from_utf8(&chunk)
            .unwrap()
            .contains("response.completed"));
        drop(stream);

        let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
        assert!(log.contains("event=completed"), "{log}");
        assert!(log.contains("status=201"), "{log}");
        assert!(log.contains("responseStatus=completed"), "{log}");
        assert!(log.contains("finish_reason=stop"), "{log}");
        assert!(!log.contains("event=failed"), "{log}");
        assert!(!log.contains("client_disconnect"), "{log}");
        let _ = std::fs::remove_file(&log_file);
    }

    #[tokio::test]
    async fn direct_sse_console_closeout_keeps_499_when_drop_before_terminal_observation() {
        let log_file = test_v3_console_log_file("direct-console-sse-drop-before-terminal");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-sse-drop-before-terminal",
            &headers,
            &json!({"model":"gpt-5.5","stream":true}),
        );
        let provider = stream::iter(vec![Ok::<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
        )])
        .chain(stream::pending::<Result<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >>());
        let frame = V3Server16HttpFrame {
            status: 200,
            content_type: "text/event-stream".to_string(),
            body: V3Server16Body::Sse(Box::pin(provider)),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(V3RuntimeObservability {
                transport: "sse".to_string(),
                response_status: Some("streaming".to_string()),
                finish_reason: None,
                usage: None,
                ..test_direct_observability(Vec::new())
            }),
            stream_observation: Some(V3RuntimeStreamObservation::default()),
        };
        let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
        let mut stream = wrap_v3_direct_sse_console_stream(
            match frame.body {
                V3Server16Body::Sse(stream) => stream,
                _ => unreachable!("test frame owns SSE body"),
            },
            finalizer,
        );
        let chunk = stream.next().await.unwrap().unwrap();
        assert!(std::str::from_utf8(&chunk)
            .unwrap()
            .contains("response.output_text.delta"));
        drop(stream);

        let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
        assert!(log.contains("event=failed"), "{log}");
        assert!(log.contains("status=499"), "{log}");
        assert!(log.contains("subcode=client_disconnect"), "{log}");
        let _ = std::fs::remove_file(&log_file);
    }

    #[tokio::test]
    async fn direct_sse_console_closeout_projects_observed_failed_terminal_as_provider_failure() {
        let log_file = test_v3_console_log_file("direct-console-sse-drop-after-failed");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-sse-drop-failed",
            &headers,
            &json!({"model":"gpt-5.5","stream":true}),
        );
        let provider = stream::iter(vec![Ok::<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream terminal failure\"}}}\n\n".to_vec(),
        )])
        .chain(stream::pending::<Result<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >>());
        let frame = V3Server16HttpFrame {
            status: 200,
            content_type: "text/event-stream".to_string(),
            body: V3Server16Body::Sse(Box::pin(provider)),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(V3RuntimeObservability {
                transport: "sse".to_string(),
                response_status: Some("streaming".to_string()),
                finish_reason: None,
                usage: None,
                ..test_direct_observability(Vec::new())
            }),
            stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
                json!({"type":"response.failed","response":{"status":"failed"}}),
            )),
        };
        let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
        let mut stream = wrap_v3_direct_sse_console_stream(
            match frame.body {
                V3Server16Body::Sse(stream) => stream,
                _ => unreachable!("test frame owns SSE body"),
            },
            finalizer,
        );
        let chunk = stream.next().await.unwrap().unwrap();
        assert!(std::str::from_utf8(&chunk)
            .unwrap()
            .contains("response.failed"));
        drop(stream);

        let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
        assert!(log.contains("event=failed"), "{log}");
        assert!(log.contains("status=502"), "{log}");
        assert!(
            log.contains("subcode=provider_response_sse_terminal_failure"),
            "{log}"
        );
        assert!(
            log.contains("response SSE stream ended with terminal status failed"),
            "{log}"
        );
        assert!(!log.contains("client_disconnect"), "{log}");
        let _ = std::fs::remove_file(&log_file);
    }

    #[tokio::test]
    async fn direct_sse_console_closeout_emits_failure_on_stream_error() {
        let log_file = test_v3_console_log_file("direct-console-sse-error");
        let _ = std::fs::remove_file(&log_file);
        let state = test_v3_listener_state(&log_file, 4444);
        let headers = test_direct_console_headers();
        let context = build_v3_console_emission_context(
            &state,
            "responses",
            "/v1/responses",
            "req-direct-console-sse-error",
            &headers,
            &json!({"model":"gpt-5.5","stream":true}),
        );
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_stream_error",
            "provider stream broke",
        );
        let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Err::<Vec<u8>, _>(source)]));
        let frame = V3Server16HttpFrame {
            status: 200,
            content_type: "text/event-stream".to_string(),
            body: V3Server16Body::Sse(stream),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "none",
            error_chain: Vec::new(),
            error_body: None,
            node_trace: vec!["V3Resp15ClientPayload"],
            observability: Some(V3RuntimeObservability {
                transport: "sse".to_string(),
                response_status: Some("streaming".to_string()),
                finish_reason: None,
                usage: None,
                ..test_direct_observability(Vec::new())
            }),
            stream_observation: None,
        };
        let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
        let response = responses_direct_output_response_with_console(frame, finalizer);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.contains("event: error"), "{text}");
        assert!(text.contains("provider_stream_error"), "{text}");
        assert!(text.contains("provider stream broke"), "{text}");

        let raw_log = std::fs::read_to_string(&log_file).unwrap();
        let log = strip_test_ansi(&raw_log);
        assert!(
            raw_log.contains(ANSI_ERROR_RED) && log.contains("event=failed"),
            "direct SSE transport error must be visibly red in raw console log: {raw_log:?}"
        );
        assert!(
            log.contains("event=failed")
                && log.contains("sessionID:direct-console-test")
                && log.contains("second.gpt-5.5")
                && log.contains("[direct")
                && log.contains("status=502")
                && log.contains("subcode=provider_response_sse_stream")
                && log.contains("provider stream broke"),
            "direct SSE transport error must emit a visible terminal failed console line: {log}"
        );
        let _ = std::fs::remove_file(&log_file);
    }

    #[test]
    fn error_observability_does_not_emit_green_completed_line() {
        let mut observability = V3RuntimeObservability {
            response_status: Some("error".to_string()),
            ..Default::default()
        };
        assert!(!should_emit_v3_request_complete_console_line(
            429,
            &observability
        ));
        assert!(!should_emit_v3_request_complete_console_line(
            200,
            &observability
        ));

        observability.response_status = Some("streaming".to_string());
        assert!(should_emit_v3_request_complete_console_line(
            200,
            &observability
        ));
    }

    #[tokio::test]
    async fn direct_stream_request_error06_projects_sse_error_not_json() {
        let frame = V3Server16HttpFrame {
            status: 429,
            content_type: "application/json".to_string(),
            body: V3Server16Body::Json(json!({
                "error": {
                    "code": "HTTP_429",
                    "message": "Rate limited by upstream provider"
                }
            })),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "V3Error06ClientProjected",
            error_chain: vec!["V3Error01SourceRaised", "V3Error06ClientProjected"],
            error_body: None,
            node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
            observability: None,
            stream_observation: None,
        };

        let projected = project_v3_responses_direct_stream_error_frame_if_requested(frame, true);
        assert_eq!(projected.status, 429);
        assert_eq!(projected.content_type, "text/event-stream");
        match projected.body {
            V3Server16Body::Sse(mut stream) => {
                let first = stream.next().await.unwrap().unwrap();
                let text = std::str::from_utf8(&first).unwrap();
                assert!(text.contains("event: error"), "{text}");
                assert!(text.contains("HTTP_429"), "{text}");
                assert!(text.contains("Rate limited by upstream provider"), "{text}");
                assert!(stream.next().await.is_none());
            }
            other => panic!("stream request Error06 must project SSE body, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn direct_continuation_scope_error_for_stream_request_projects_sse_not_json() {
        let log_file = test_v3_console_log_file("direct-continuation-scope-sse-error");
        let state = test_v3_listener_state(&log_file, 5555);
        let mut headers = HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("text/event-stream"));
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        let frame = execute_responses_direct_server_frame(
            state.as_ref(),
            &headers,
            "POST".to_string(),
            "/v1/responses".to_string(),
            "req-direct-sse-scope-error".to_string(),
            "exec-direct-sse-scope-error".to_string(),
            json!({
                "model":"gpt-5.5",
                "stream":true,
                "previous_response_id":"never_committed",
                "input":[{"type":"function_call_output","call_id":"call_1","output":"ok"}]
            }),
            None,
        )
        .await;
        assert_eq!(frame.status, 400);
        assert_eq!(frame.content_type, "text/event-stream");
        assert_eq!(
            v3_server_frame_error_body_for_console(&frame)
                .and_then(|body| body.pointer("/error/code"))
                .and_then(Value::as_str),
            Some("malformed_json")
        );
        assert!(format_v3_error_console_content(
            "/v1/responses",
            "req-direct-sse-scope-error",
            frame.status,
            &frame.error_chain,
            v3_server_frame_error_body_for_console(&frame),
        )
        .contains("Responses continuation requires"));
        match frame.body {
            V3Server16Body::Sse(mut stream) => {
                let first = stream.next().await.unwrap().unwrap();
                let text = std::str::from_utf8(&first).unwrap();
                assert!(text.contains("event: error"), "{text}");
                assert!(text.contains("malformed_json"), "{text}");
                assert!(text.contains("Responses continuation requires"), "{text}");
                assert!(stream.next().await.is_none());
            }
            other => panic!("stream continuation scope error must project SSE body, got {other:?}"),
        }
        let _ = std::fs::remove_file(&log_file);
    }

    #[tokio::test]
    async fn accept_sse_error06_without_payload_projects_sse_error_not_json() {
        let mut headers = HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("text/event-stream"));
        let frame = V3Server16HttpFrame {
            status: 400,
            content_type: "application/json".to_string(),
            body: V3Server16Body::Json(json!({
                "error": {
                    "code": "malformed_json",
                    "message": "malformed JSON request body"
                }
            })),
            debug_node: "V3Debug01NodeEventRegistered",
            error_node: "V3Error06ClientProjected",
            error_chain: vec!["V3Error01SourceRaised", "V3Error06ClientProjected"],
            error_body: None,
            node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
            observability: None,
            stream_observation: None,
        };

        let projected = project_v3_responses_error_frame_for_request_if_sse(frame, &headers, None);
        assert_eq!(projected.content_type, "text/event-stream");
        match projected.body {
            V3Server16Body::Sse(mut stream) => {
                let first = stream.next().await.unwrap().unwrap();
                let text = std::str::from_utf8(&first).unwrap();
                assert!(text.contains("event: error"), "{text}");
                assert!(text.contains("malformed_json"), "{text}");
                assert!(text.contains("malformed JSON request body"), "{text}");
                assert!(stream.next().await.is_none());
            }
            other => panic!("Accept SSE Error06 must project SSE body, got {other:?}"),
        }
    }

    #[test]
    fn error_projection_appends_human_console_failure_line() {
        let log_file = std::env::temp_dir().join(format!(
            "routecodex-v3-error-console-{}-{}.log",
            std::process::id(),
            console_timestamp_hhmmss()
        ));
        let _ = std::fs::remove_file(&log_file);
        let mut servers = BTreeMap::new();
        let server = V3ServerManifest {
            id: "server".to_string(),
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port: 5555,
            routing_group: "controlled".to_string(),
            endpoints: vec!["responses".to_string()],
            features: BTreeMap::new(),
            execution: None,
        };
        servers.insert(server.id.clone(), server.clone());
        let manifest = Arc::new(V3Config05ManifestPublished {
            version: 3,
            hub_v1: None,
            servers,
            providers: BTreeMap::new(),
            forwarders: BTreeMap::new(),
            route_groups: BTreeMap::new(),
            features: BTreeMap::new(),
            debug: V3DebugManifest {
                log_console: false,
                log_file: Some(log_file.to_string_lossy().to_string()),
                snapshots: false,
                snapshot_stages: None,
                dry_run: false,
                retention: BTreeMap::new(),
            },
            error: routecodex_v3_config::V3ErrorManifest {
                policies: BTreeMap::new(),
                provider_error_action_policy: Vec::new(),
                client_error_projection_policy: Vec::new(),
            },
        });
        let debug = build_v3_debug_runtime_from_manifest(&manifest.debug).unwrap();
        let state = V3ListenerState {
            server,
            manifest_version: manifest.version,
            manifest: Arc::clone(&manifest),
            debug: debug.clone(),
            console_enabled: true,
            request_counter: Arc::new(Mutex::new(V3RequestIdCounter::new())),
            responses_direct_continuation: Arc::new(V3ResponsesDirectContinuationState::default()),
            responses_relay_local_continuation: Arc::new(
                V3ResponsesRelayLocalContinuationState::default(),
            ),
            responses_relay_stopless_control: Arc::new(
                V3ResponsesRelayStoplessControlState::default(),
            ),
            provider_health: Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
                &manifest,
            )),
            responses_direct_transport: Arc::new(V3ResponsesRelayDefaultTransport::default()),
        };
        let trace_scope = state
            .debug
            .start_trace("server", "req-error-console", "exec-error-console")
            .unwrap();

        let response = record_and_emit_v3_error_projection(
            &state,
            &trace_scope,
            V3ErrorProjectionConsoleInput {
                endpoint: "/v1/responses",
                request_id: "req-error-console",
                status: 500,
                error_chain: &V3_ERROR_CHAIN_NODE_IDS,
                body: Some(&json!({
                    "error": {
                        "type":"runtime_error",
                        "message":"controlled error"
                    }
                })),
                project_path: None,
            },
        );

        assert!(response.is_none());
        let log = std::fs::read_to_string(&log_file).unwrap();
        let plain_log = strip_test_ansi(&log);
        assert!(
            plain_log.contains("❌ [/v1/responses]")
                && plain_log.contains("req=req-error-console event=failed")
                && plain_log.contains("message=controlled error"),
            "human console log must include the visible failed line, not only JSON debug events: {log}"
        );
        let _ = std::fs::remove_file(&log_file);
    }

    #[test]
    fn stopless_console_activation_requires_action_stop_and_uses_fixed_color() {
        let active = V3RuntimeObservability {
            response_status: Some("requires_action".to_string()),
            finish_reason: Some("tool_calls".to_string()),
            stopless_activation: true,
            ..Default::default()
        };
        assert!(is_v3_stopless_console_activation(&active));

        let completed = V3RuntimeObservability {
            response_status: Some("completed".to_string()),
            finish_reason: Some("stop".to_string()),
            stopless_activation: false,
            ..Default::default()
        };
        assert!(!is_v3_stopless_console_activation(&completed));

        let previous = std::env::var_os("ROUTECODEX_FORCE_LOG_COLOR");
        std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", "1");
        let colored = colorize_v3_stopless_console_line(
            "[5555:responses:sessionID:xxxx][rules][glmrelay_openai.glm-5.2][tools] 🧭 [stopless] 00:00:00 req=req event=activated hook=reasoningStop callId=call_stopless_reasoning action=exec_command finish_reason=stop transport=sse",
        );
        if let Some(previous) = previous {
            std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", previous);
        } else {
            std::env::remove_var("ROUTECODEX_FORCE_LOG_COLOR");
        }
        assert!(
            colored.starts_with(ANSI_STOPLESS_PURPLE),
            "stopless console line must use fixed purple color: {colored:?}"
        );
        assert!(colored.contains("hook="));
        assert!(colored.contains("reasoningStop"));
        assert!(colored.contains("callId="));
        assert!(colored.contains("call_stopless_reasoning"));
    }

    #[tokio::test]
    async fn relay_sse_closeout_emits_complete_once_on_stream_eof_without_semantic_parsing() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut stream = wrap_v3_relay_sse_closeout_stream(
            Box::pin(futures_util::stream::iter(vec![Ok(
                b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec()
            )])),
            move |terminal| recorded.lock().unwrap().push(terminal),
        );

        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec()
        );
        assert!(stream.next().await.is_none());
        drop(stream);

        assert_eq!(
            *events.lock().unwrap(),
            vec![V3SseConsoleStreamTerminal::Completed]
        );
    }

    #[tokio::test]
    async fn relay_sse_closeout_treats_requires_action_as_opaque_payload_until_eof() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut stream = wrap_v3_relay_sse_closeout_stream(
            Box::pin(futures_util::stream::iter(vec![
                Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"status\":\"requires_action\"}}\n\n".to_vec()),
                Ok(b"event: response.requires_action\ndata: {\"type\":\"response.requires_action\",\"response\":{\"status\":\"requires_action\",\"output\":[{\"type\":\"custom_tool_call\",\"call_id\":\"call_1\",\"name\":\"exec\",\"input\":\"{}\"}]}}\n\n".to_vec()),
                Ok(b"data: [DONE]\n\n".to_vec()),
            ])),
            move |terminal| recorded.lock().unwrap().push(terminal),
        );

        let chunks = stream.by_ref().collect::<Vec<_>>().await;
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(Result::is_ok));
        drop(stream);

        assert_eq!(
            *events.lock().unwrap(),
            vec![V3SseConsoleStreamTerminal::Completed]
        );
    }

    #[tokio::test]
    async fn relay_sse_closeout_does_not_fail_by_parsing_nonterminal_payload() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut stream = wrap_v3_relay_sse_closeout_stream(
            Box::pin(futures_util::stream::iter(vec![Ok(
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
                    .to_vec(),
            )])),
            move |terminal| recorded.lock().unwrap().push(terminal),
        );

        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()
        );
        assert!(stream.next().await.is_none());
        drop(stream);

        assert_eq!(
            *events.lock().unwrap(),
            vec![V3SseConsoleStreamTerminal::Completed]
        );
    }

    #[tokio::test]
    async fn relay_sse_closeout_does_not_parse_response_failed_terminal_payload() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut stream = wrap_v3_relay_sse_closeout_stream(
            Box::pin(futures_util::stream::iter(vec![Ok(
                b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream stream failed\"}}}\n\n".to_vec(),
            )])),
            move |terminal| recorded.lock().unwrap().push(terminal),
        );

        let chunk = stream.next().await.unwrap().unwrap();
        assert!(std::str::from_utf8(&chunk)
            .unwrap()
            .contains("response.failed"));
        assert!(stream.next().await.is_none());
        drop(stream);

        assert_eq!(
            *events.lock().unwrap(),
            vec![V3SseConsoleStreamTerminal::Completed]
        );
    }

    #[tokio::test]
    async fn relay_sse_body_projects_stream_error_event_instead_of_abrupt_close() {
        let output = V3ResponsesRelayRuntimeOutput {
            status: 200,
            client_body: V3ResponsesRelayClientBody::Sse(Box::pin(futures_util::stream::iter(
                vec![Err("provider relay boom".to_string())],
            ))),
            node_trace: vec!["V3HubRespOutbound05ClientSemantic"],
            error_chain: None,
            observability: None,
            stream_observation: None,
            finalized_response: None,
            provider_snapshots: None,
        };

        let response = responses_relay_output_response(output, None);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.contains("event: error"), "{text}");
        assert!(text.contains("provider_response_sse_stream"), "{text}");
        assert!(text.contains("provider relay boom"), "{text}");
    }

    #[tokio::test]
    async fn relay_sse_closeout_emits_failure_once_on_provider_stream_error() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut stream = wrap_v3_relay_sse_closeout_stream(
            Box::pin(futures_util::stream::iter(vec![Err(
                "provider boom".to_string()
            )])),
            move |terminal| recorded.lock().unwrap().push(terminal),
        );

        assert_eq!(stream.next().await.unwrap().unwrap_err(), "provider boom");
        drop(stream);

        assert_eq!(
            *events.lock().unwrap(),
            vec![V3SseConsoleStreamTerminal::Failed(
                "provider boom".to_string()
            )]
        );
    }

    #[tokio::test]
    async fn relay_sse_closeout_emits_drop_when_client_disconnects_before_terminal() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let provider = futures_util::stream::iter(vec![Ok(b"data: first\n\n".to_vec())])
            .chain(futures_util::stream::pending::<Result<Vec<u8>, String>>());
        let mut stream = wrap_v3_relay_sse_closeout_stream(Box::pin(provider), move |terminal| {
            recorded.lock().unwrap().push(terminal)
        });

        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            b"data: first\n\n".to_vec()
        );
        drop(stream);

        assert_eq!(
            *events.lock().unwrap(),
            vec![V3SseConsoleStreamTerminal::Dropped]
        );
    }

    #[tokio::test]
    async fn relay_sse_closeout_treats_drop_after_semantic_terminal_frame_as_transport_drop() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let provider = futures_util::stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
        )])
        .chain(futures_util::stream::pending::<Result<Vec<u8>, String>>());
        let mut stream = wrap_v3_relay_sse_closeout_stream(Box::pin(provider), move |terminal| {
            recorded.lock().unwrap().push(terminal)
        });

        let chunk = stream.next().await.unwrap().unwrap();
        assert!(std::str::from_utf8(&chunk)
            .unwrap()
            .contains("response.completed"));
        drop(stream);

        assert_eq!(
            *events.lock().unwrap(),
            vec![V3SseConsoleStreamTerminal::Dropped]
        );
    }
}
