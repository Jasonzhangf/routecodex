mod responses_direct_server_outcome;
mod session_admission;
mod console;
mod models_catalog;
mod request_id;

use request_id::{
    format_v3_tm, v3_request_id_clock_now, V3AllocatedRequestIdentity, V3RequestCounterState,
    V3RequestIdCounter,
};

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
use responses_direct_server_outcome::{
    execute_responses_direct_server_outcome, V3ResponsesDirectServerOutcome,
};
use routecodex_v3_config::{
    collect_v3_route_group_catalog_model_refs, resolve_routecodex_package_version_from_executable,
    V3Config05ManifestPublished, V3DebugManifest, V3EntryProtocolExecutionMode, V3ServerManifest,
};
use routecodex_v3_debug::{
    V3DebugBoundedTextCapture, V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig,
    V3DebugTraceScope, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_error::{
    project_v3_http_boundary_error, project_v3_post_commit_sse_source,
    project_v3_server_invalid_request, project_v3_server_runtime_failure,
    project_v3_server_websocket_error, raise_v3_debug_artifact_failure,
    raise_v3_runtime_observability_contract_failure, raise_v3_sse_client_disconnect,
    raise_v3_sse_provider_failure, V3Error01SourceRaised, V3HttpBoundaryErrorKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw,
    execute_v3_anthropic_relay_dry_run_runtime_with_client_headers,
    execute_v3_anthropic_relay_runtime_with_default_transport,
    execute_v3_anthropic_relay_runtime_with_default_transport_and_client_headers,
    execute_v3_anthropic_relay_runtime_with_default_transport_client_headers_provider_health,
    execute_v3_foundation_pending_runtime, execute_v3_gemini_relay_runtime_with_default_transport,
    execute_v3_gemini_relay_runtime_with_default_transport_provider_health,
    execute_v3_openai_chat_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health,
    execute_v3_responses_direct_dry_run_runtime,
    execute_v3_responses_direct_dry_run_runtime_with_initial_target,
    execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug,
    execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target,
    execute_v3_responses_relay_dry_run_orchestration_outcome_with_local_continuation_and_stopless_control,
    execute_v3_responses_relay_runtime_with_default_transport, V3ChatDirectCodec,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_provider_snapshots_and_initial_target,
    project_v3_anthropic_relay_runtime_failure, project_v3_debug_failure,
    project_v3_gemini_relay_runtime_failure, project_v3_openai_chat_relay_runtime_failure,
    project_v3_responses_previous_response_owner_resolution_error,
    project_v3_responses_relay_runtime_failure, project_v3_virtual_router_dry_run,
    project_v3_virtual_router_status, register_responses_direct_hooks,
    resolve_v3_responses_previous_response_owner_execution_mode_at_req03,
    V3AnthropicRelayClientHeader, V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput,
    V3ClientBody, V3ClientSseStream, V3FoundationRuntimeInput, V3FoundationRuntimeOutput,
    V3GeminiRelayClientBody, V3GeminiRelayRuntimeInput, V3GeminiRelayRuntimeOutput,
    V3OpenAiChatClientStream, V3OpenAiChatRelayClientBody, V3OpenAiChatRelayRuntimeInput,
    V3OpenAiChatRelayRuntimeOutput,
    V3Resp15ClientPayload, V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
    V3ResponsesDirectRuntimeSharedState, V3ResponsesDirectStoplessControlState,
    V3ResponsesProtocolExecutionPlan, V3ResponsesRelayClientBody, V3ResponsesRelayClientStream,
    V3ResponsesRelayDryRunOutcome, V3ResponsesRelayLocalContinuationScope,
    V3ResponsesRelayLocalContinuationState, V3ResponsesRelayLocalStoplessControlInput,
    V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayProviderSnapshotCapture,
    V3ResponsesRelayRuntimeError, V3ResponsesRelayRuntimeInput, V3ResponsesRelayRuntimeOutput,
    V3ResponsesRelayStoplessControlState, V3RuntimeObservability,
    V3RuntimeObservabilityAccumulator, V3RuntimeProviderFailureEventSink,
    V3RuntimeProviderFailureObservation, V3RuntimeRouteSelectionEventSink,
    V3RuntimeStreamObservation, V3RuntimeTimingSummary, V3RuntimeUsageSummary,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, build_v3_sse_transport_in_02_from_fields,
    build_v3_sse_transport_in_03_from_v3_sse_transport_in_02,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03,
    build_v3_sse_transport_out_04_keepalive_comment, SseField, SseIncrementalDecoder,
    SseTransportLimits,
};
use serde_json::{json, Map, Value};
use session_admission::{
    hold_response_body_admission_permit, V3ResponsesSessionAdmissionGate,
    V3ResponsesSessionAdmissionPermit, V3ResponsesSessionAdmissionScope,
};
use std::collections::BTreeSet;
use std::env;
use std::fmt;
use std::fs;
use std::io;
use std::io::Read as _;
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const V3_PROTOCOL_PENDING_PROJECTION_RESOURCE: &str = "v3.protocol.pending_projection";
// feature_id: v3.codex_sample_retention_snap_scope
// sample persistence is owned solely by routecodex-v3-debug::V3CodexSampleStore.

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
    codex_sample_store: Arc<routecodex_v3_debug::V3CodexSampleStore>,
    responses_direct_continuation: Arc<V3ResponsesDirectContinuationState>,
    responses_direct_stopless_control: Arc<V3ResponsesDirectStoplessControlState>,
    responses_relay_local_continuation: Arc<V3ResponsesRelayLocalContinuationState>,
    responses_relay_stopless_control: Arc<V3ResponsesRelayStoplessControlState>,
    provider_health: Arc<V3ResponsesRelayProviderHealthHandle>,
    responses_session_admission: Arc<V3ResponsesSessionAdmissionGate>,
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
    let responses_direct_stopless_control =
        Arc::new(V3ResponsesDirectStoplessControlState::default());
    let responses_relay_local_continuation =
        Arc::new(V3ResponsesRelayLocalContinuationState::default());
    let responses_relay_stopless_control =
        Arc::new(V3ResponsesRelayStoplessControlState::default());
    let provider_health = Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
        &manifest,
    ));
    let codex_sample_store = Arc::new(routecodex_v3_debug::V3CodexSampleStore::new(
        manifest.debug.codex_samples,
        routecodex_v3_debug::V3_CODEX_SAMPLE_REQUEST_RETENTION,
    ));
    for server in &preflight.listeners {
        codex_sample_store
            .enforce_listener_retention(server.port)
            .map_err(std::io::Error::other)?;
    }
    let mut bound = Vec::with_capacity(preflight.listeners.len());
    for server in preflight.listeners {
        let addr: SocketAddr = format!("{}:{}", server.bind, server.port)
            .parse()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let listener = TcpListener::bind(addr).await?;
        let bound_addr = listener.local_addr()?;
        bound.push((server, listener, bound_addr));
    }

    let request_counter = Arc::new(Mutex::new(V3RequestIdCounter::new()));
    let mut listeners = Vec::with_capacity(bound.len());
    for (server, listener, addr) in bound {
        let server_id = server.id.clone();
        let app = build_v3_listener_router(V3ListenerState {
            server,
            manifest_version: preflight.manifest_version,
            manifest: manifest.clone(),
            debug: debug.clone(),
            console_enabled,
            request_counter: Arc::clone(&request_counter),
            codex_sample_store: codex_sample_store.clone(),
            responses_direct_continuation: responses_direct_continuation.clone(),
            responses_direct_stopless_control: responses_direct_stopless_control.clone(),
            responses_relay_local_continuation: responses_relay_local_continuation.clone(),
            responses_relay_stopless_control: responses_relay_stopless_control.clone(),
            provider_health: provider_health.clone(),
            responses_session_admission: Arc::new(V3ResponsesSessionAdmissionGate::default()),
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
    let state = Arc::new(state);
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
        .with_state(state)
}

async fn health(State(state): State<Arc<V3ListenerState>>) -> Json<serde_json::Value> {
    let executable_path = std::env::current_exe()
        .expect("V3 health requires current executable path for build_version truth");
    let build_version = resolve_routecodex_package_version_from_executable(&executable_path)
        .expect("V3 health requires installed package.json build_version truth");
    Json(json!({
        "status": "ok",
        "version": 3,
        "build_version": build_version,
        "manifest_version": state.manifest_version,
        "server_id": state.server.id,
        "bind": state.server.bind,
        "port": state.server.port,
    }))
}

async fn models_endpoint(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    json_response(
        200,
        models_catalog::build_v3_models_catalog(
            &state.manifest,
            &state.server.routing_group,
            &state.server.expose_models,
        ),
    )
}

async fn virtual_router_status(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response<Body> {
    if !remote.ip().is_loopback() {
        return error_output_response_for_server(
            &state.server,
            "/_routecodex/diagnostics/virtual-router",
            "diagnostics",
            project_v3_server_invalid_request(
                "V3Server03HttpRequestRaw",
                "forbidden",
                "forbidden",
                403,
            ),
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
        Err(message) => error_output_response_for_server(
            &state.server,
            "/_routecodex/diagnostics/virtual-router",
            "diagnostics",
            project_v3_server_runtime_failure(
                "V3RouterDiagnostics",
                "virtual_router_diagnostics_failed",
                message,
                500,
            ),
        ),
    }
}

async fn virtual_router_dry_run(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response<Body> {
    if !remote.ip().is_loopback() {
        return error_output_response_for_server(
            &state.server,
            "/_routecodex/diagnostics/virtual-router/dry-run",
            "diagnostics",
            project_v3_server_invalid_request(
                "V3Server03HttpRequestRaw",
                "forbidden",
                "forbidden",
                403,
            ),
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
        Err(message) => error_output_response_for_server(
            &state.server,
            "/_routecodex/diagnostics/virtual-router/dry-run",
            "diagnostics",
            project_v3_server_runtime_failure(
                "V3RouterDiagnostics",
                "virtual_router_dry_run_failed",
                message,
                500,
            ),
        ),
    }
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn admit_v3_responses_session_after_json_parse(
    state: &Arc<V3ListenerState>,
    path: &str,
    request_headers: &HeaderMap,
    payload: &Value,
) -> Result<Option<V3ResponsesSessionAdmissionPermit>, Response<Body>> {
    let (session_id, conversation_id) = match responses_control_scope_headers(request_headers) {
        Ok(scope) => scope,
        Err(message) => {
            let request_id = match allocate_v3_console_request_id(state, path, Some(payload)) {
                Ok(request_id) => request_id,
                Err(response) => return Err(*response),
            };
            return Err(
                error_output_response_for_responses_request_with_project_path(
                    &state.server,
                    path,
                    &request_id,
                    project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
                    request_headers,
                    Some(payload),
                    resolve_v3_console_project_path(request_headers, payload).as_deref(),
                ),
            );
        }
    };
    let permit = match state.responses_session_admission.try_admit(
        V3ResponsesSessionAdmissionScope {
            endpoint: "/v1/responses".to_string(),
            session_id,
            conversation_id,
        },
    ) {
        Ok(permit) => permit,
        Err(()) => {
            let request_id = match allocate_v3_console_request_id(state, path, Some(payload)) {
                Ok(request_id) => request_id,
                Err(response) => return Err(*response),
            };
            return Err(error_output_response_for_responses_request_with_project_path(
                &state.server,
                path,
                &request_id,
                project_http_input_error(
                    V3HttpBoundaryErrorKind::RequestInFlight,
                    "another /v1/responses request is still active for this listener session or conversation",
                ),
                request_headers,
                Some(payload),
                resolve_v3_console_project_path(request_headers, payload).as_deref(),
            ));
        }
    };
    Ok(permit)
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
    let execution_mode = binding.execution_mode;
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
            return responses_direct_output_response(
                frame,
                Duration::from_millis(state.server.http_sse_keepalive_ms),
            );
        }
    };
    let admission_permit = if entry_protocol == "responses" {
        match admit_v3_responses_session_after_json_parse(&state, &path, &request_headers, &payload)
        {
            Ok(permit) => permit,
            Err(response) => return response,
        }
    } else {
        None
    };
    let response = pending_endpoint_after_responses_admission(
        state,
        request_headers,
        method,
        path,
        started_at,
        entry_protocol,
        execution_mode,
        pending_owner_symbol,
        payload,
    )
    .await;
    match admission_permit {
        Some(permit) => hold_response_body_admission_permit(response, permit),
        None => response,
    }
}

async fn pending_endpoint_after_responses_admission(
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
                .await
            }
            None => {
                execute_v3_responses_direct_dry_run_runtime(fixture, &state.manifest, &state.debug)
                    .await
            }
        };
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
                            .redact_payload_for_side_channel(raw_request_payload.clone()),
                    );
                    let _ = persist_v3_error_evidence_payload(
                        &state,
                        &entry_protocol,
                        &path,
                        &request_id,
                        "error.json",
                        &json!({
                            "object": "routecodex.v3.error_evidence",
                            "stage": "error",
                            "status": frame.status,
                            "request_id": request_id,
                            "endpoint": path,
                            "node_trace": frame.node_trace.clone(),
                            "error_chain": frame.error_chain.clone(),
                            "observability": frame.observability.as_ref().map(project_v3_runtime_observability_debug),
                        }),
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

fn prepend_v3_relay_handoff_trace_to_direct_frame(
    frame: &mut V3Server16HttpFrame,
    relay_trace: &[&'static str],
) {
    frame.node_trace = merge_v3_protocol_plan_trace(relay_trace.to_vec(), frame.node_trace.clone());
}

fn merge_v3_direct_handoff_provider_failure_events(
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

fn merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
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

fn allocate_v3_console_request_id(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<String, Box<Response<Body>>> {
    allocate_v3_console_request_identity(state, endpoint, payload)
        .map(|identity| identity.request_id)
}

fn allocate_v3_console_request_identity(
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

fn next_v3_console_request_identity(
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

fn format_v3_request_id_entry(endpoint: &str) -> String {
    let raw = endpoint.to_ascii_lowercase();
    if raw.contains("/v1/responses") {
        "openai-responses".to_string()
    } else if raw.contains("/v1/messages") || raw.contains("/anthropic") {
        "anthropic-messages".to_string()
    } else {
        "openai-chat".to_string()
    }
}

fn format_v3_request_id_token(value: &str) -> String {
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
    let effective_execution_mode =
        responses_effective_execution_mode_for_entry_facts(execution_mode, &entry_facts);
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

async fn execute_responses_relay_websocket_output(
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
    let projected = project_v3_server_websocket_error(code, message);
    let event = json!({
        "type": "error",
        "error": projected.body["error"].clone()
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

/// relay 分支共享：error_chain 存在时做 console 投影（4 个 relay 分支同构样板收敛）。
fn emit_relay_error_chain_if_any(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    path: &str,
    request_id: &str,
    status: u16,
    error_chain: Option<&[&'static str]>,
    body: Option<&Value>,
    request_console_project_path: Option<&str>,
) -> Option<Response<Body>> {
    let error_chain = error_chain?;
    record_and_emit_v3_error_projection(
        state,
        trace_scope,
        V3ErrorProjectionConsoleInput {
            endpoint: path,
            request_id,
            status,
            error_chain,
            body,
            project_path: request_console_project_path,
        },
    )
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

#[derive(Clone)]
struct V3LiveSnapSseRecorderCore {
    state: Arc<V3ListenerState>,
    entry_protocol: String,
    endpoint: String,
    request_id: String,
    status: u16,
    node_trace: Vec<&'static str>,
    error_chain: Option<Vec<&'static str>>,
    observability: Option<Value>,
    finalized_response: Option<Value>,
    source: &'static str,
    raw_sse: Arc<Mutex<V3DebugBoundedTextCapture>>,
}

impl V3LiveSnapSseRecorderCore {
    fn persist_initial(&self) -> Result<(), String> {
        self.persist_current(None)
    }

    fn append_chunk(&self, bytes: &[u8]) -> Result<(), String> {
        self.raw_sse
            .lock()
            .map_err(|error| error.to_string())?
            .append(bytes);
        Ok(())
    }

    fn persist_current(&self, stream_error: Option<&str>) -> Result<(), String> {
        let raw_sse = self
            .raw_sse
            .lock()
            .map_err(|error| error.to_string())?
            .rendered_text();
        let mut payload = json!({
            "object": "routecodex.v3.client_response_snapshot",
            "stage": "client-response",
            "source": self.source,
            "status": self.status,
            "bodyKind": "sse",
            "rawSse": raw_sse,
            "node_trace": self.node_trace.clone(),
            "error_chain": self.error_chain.clone(),
        });
        if let Some(observability) = self.observability.as_ref() {
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "observability".to_string(),
                    observability.clone(),
                );
            }
        }
        if let Some(finalized_response) = self.finalized_response.as_ref() {
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "materializedResponse".to_string(),
                    finalized_response.clone(),
                );
            }
        }
        if let Some(stream_error) = stream_error {
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "streamError".to_string(),
                    Value::String(stream_error.to_string()),
                );
            }
        }
        let payload = self.state.debug.redact_payload_for_side_channel(payload);
        persist_v3_codex_sample_payload(
            &self.state,
            &self.entry_protocol,
            &self.endpoint,
            &self.request_id,
            "response.json",
            &payload,
        )
    }
}

struct V3LiveSnapRecordedStream<S, E, F, O> {
    inner: S,
    recorder: V3LiveSnapSseRecorderCore,
    terminal_persisted: bool,
    error_message: F,
    map_error: O,
    _phantom: std::marker::PhantomData<E>,
}

impl<S, E, F, O, OErr> futures_util::Stream for V3LiveSnapRecordedStream<S, E, F, O>
where
    S: futures_util::Stream<Item = Result<Vec<u8>, E>> + futures_util::StreamExt + Unpin,
    E: Unpin,
    F: Fn(&E) -> String + Unpin,
    O: Fn(String) -> OErr + Unpin,
{
    type Item = Result<Vec<u8>, OErr>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match std::pin::Pin::new(&mut this.inner).poll_next(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(bytes))) => match this.recorder.append_chunk(&bytes) {
                Ok(()) => Poll::Ready(Some(Ok(bytes))),
                Err(error) => {
                    this.terminal_persisted = true;
                    Poll::Ready(Some(Err((this.map_error)(error))))
                }
            },
            Poll::Ready(Some(Err(error))) => {
                this.terminal_persisted = true;
                let message = (this.error_message)(&error);
                match this.recorder.persist_current(Some(&message)) {
                    Ok(()) => Poll::Ready(Some(Err((this.map_error)(message)))),
                    Err(persistence_error) => Poll::Ready(Some(Err((this.map_error)(format!(
                        "{message}; codex sample persistence failed: {persistence_error}"
                    ))))),
                }
            }
            Poll::Ready(None) if !this.terminal_persisted => {
                this.terminal_persisted = true;
                match this.recorder.persist_current(None) {
                    Ok(()) => Poll::Ready(None),
                    Err(error) => Poll::Ready(Some(Err((this.map_error)(error)))),
                }
            }
            Poll::Ready(None) => Poll::Ready(None),
        }
    }
}

struct V3LiveSnapClientResponseSseRecorder {
    core: V3LiveSnapSseRecorderCore,
}

impl V3LiveSnapClientResponseSseRecorder {
    fn new(
        state: Arc<V3ListenerState>,
        entry_protocol: String,
        endpoint: String,
        request_id: String,
        output: &V3ResponsesRelayRuntimeOutput,
    ) -> Self {
        Self {
            core: V3LiveSnapSseRecorderCore {
                state,
                entry_protocol,
                endpoint,
                request_id,
                status: output.status,
                node_trace: output.node_trace.clone(),
                error_chain: output.error_chain.clone(),
                observability: output
                    .observability
                    .as_ref()
                    .map(project_v3_runtime_observability_debug),
                finalized_response: output.finalized_response.clone(),
                source: "live_server_response_stream",
                raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
            },
        }
    }

    fn wrap(&self, stream: V3ResponsesRelayClientStream) -> V3ResponsesRelayClientStream {
        Box::pin(V3LiveSnapRecordedStream {
            inner: stream,
            recorder: self.core.clone(),
            terminal_persisted: false,
            error_message: |error: &String| error.clone(),
            map_error: |message: String| message,
            _phantom: std::marker::PhantomData,
        })
    }

    fn persist_initial(&self) -> Result<(), String> {
        self.core.persist_initial()
    }
}

struct V3LiveSnapRelayRecordedStream {
    inner: V3ResponsesRelayClientStream,
    recorder: V3LiveSnapClientResponseSseRecorder,
    terminal_persisted: bool,
}

#[derive(Clone)]
struct V3LiveSnapDirectClientResponseSseRecorder {
    core: V3LiveSnapSseRecorderCore,
}

impl V3LiveSnapDirectClientResponseSseRecorder {
    fn new(
        state: Arc<V3ListenerState>,
        entry_protocol: String,
        endpoint: String,
        request_id: String,
        frame: &V3Server16HttpFrame,
    ) -> Self {
        Self {
            core: V3LiveSnapSseRecorderCore {
                state,
                entry_protocol,
                endpoint,
                request_id,
                status: frame.status,
                node_trace: frame.node_trace.clone(),
                error_chain: Some(frame.error_chain.clone()),
                observability: frame
                    .observability
                    .as_ref()
                    .map(project_v3_runtime_observability_debug),
                finalized_response: None,
                source: "live_server_direct_response_stream",
                raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
            },
        }
    }

    fn wrap(&self, stream: V3ClientSseStream) -> V3ClientSseStream {
        Box::pin(V3LiveSnapRecordedStream {
            inner: stream,
            recorder: self.core.clone(),
            terminal_persisted: false,
            error_message: |error: &V3Error01SourceRaised| error.message.clone(),
            map_error: v3_codex_sample_stream_error,
            _phantom: std::marker::PhantomData,
        })
    }

    fn persist_initial(&self) -> Result<(), String> {
        self.core.persist_initial()
    }
}

fn v3_codex_sample_stream_error(message: String) -> V3Error01SourceRaised {
    raise_v3_debug_artifact_failure(message)
}

fn capture_v3_live_raw_request(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    entry_protocol: &str,
    execution_mode: V3EntryProtocolExecutionMode,
    endpoint: &str,
    request_id: &str,
    payload: &Value,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-request") {
        return None;
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        if !v3_codex_sample_scope_allows(state, execution_mode) {
            return None;
        }
        let payload = state.debug.redact_payload_for_side_channel(payload.clone());
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "request.json",
            &payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug02RawRequestCaptured",
                V3DebugError::Sink(error),
            )));
        }
        return None;
    }
    let projection = match state
        .debug
        .capture_raw_request(trace_scope, payload.clone())
    {
        Ok(projection) => projection,
        Err(error) => {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug02RawRequestCaptured",
                error,
            )));
        }
    };
    if let Some(projection) = projection {
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "request.json",
            &projection.payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug02RawRequestCaptured",
                V3DebugError::Sink(error),
            )));
        }
    }
    None
}

fn capture_v3_responses_relay_response(
    state: &Arc<V3ListenerState>,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response") {
        return None;
    }
    let payload = match &output.client_body {
        V3ResponsesRelayClientBody::Json(value) => value.clone(),
        V3ResponsesRelayClientBody::Sse(_) => {
            let payload = json!({
                "object": "routecodex.v3.client_response_snapshot",
                "stage": "client-response",
                "source": "live_server_response_stream",
                "bodyKind": "sse",
                "rawSse": "",
                "stream": true,
                "materializedResponse": output.finalized_response.clone(),
                "status": output.status,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
                "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
            });
            let projection = match state
                .debug
                .capture_raw_response(trace_scope, payload.clone())
            {
                Ok(projection) => projection,
                Err(error) => {
                    return Some(foundation_output_response(project_v3_debug_failure(
                        "V3Debug03RawResponseCaptured",
                        error,
                    )));
                }
            };
            if let Some(projection) = projection {
                if let Err(error) = persist_v3_codex_sample_payload(
                    state,
                    entry_protocol,
                    endpoint,
                    request_id,
                    "response.json",
                    &projection.payload,
                ) {
                    return Some(foundation_output_response(project_v3_debug_failure(
                        "V3Debug03RawResponseCaptured",
                        V3DebugError::Sink(error),
                    )));
                }
            }
            let V3ResponsesRelayClientBody::Sse(stream) = std::mem::replace(
                &mut output.client_body,
                V3ResponsesRelayClientBody::Json(Value::Null),
            ) else {
                unreachable!("matched SSE client body");
            };
            let recorder = V3LiveSnapClientResponseSseRecorder::new(
                Arc::clone(state),
                entry_protocol.to_string(),
                endpoint.to_string(),
                request_id.to_string(),
                output,
            );
            if let Err(error) = recorder.persist_initial() {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
            output.client_body = V3ResponsesRelayClientBody::Sse(recorder.wrap(stream));
            return None;
        }
    };
    let projection = match state.debug.capture_raw_response(trace_scope, payload) {
        Ok(projection) => projection,
        Err(error) => {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                error,
            )));
        }
    };
    if let Some(projection) = projection {
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "response.json",
            &projection.payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                V3DebugError::Sink(error),
            )));
        }
    }
    None
}

fn capture_v3_openai_chat_relay_response(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    raw_request_payload: &Value,
    output: &mut V3OpenAiChatRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let force_error_evidence = output.status >= 400 || output.error_chain.is_some();
    if force_error_evidence {
        let _ = persist_v3_error_evidence_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "request.json",
            &state
                .debug
                .redact_payload_for_side_channel(raw_request_payload.clone()),
        );
        let _ = persist_v3_error_evidence_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "error.json",
            &json!({
                "object": "routecodex.v3.error_evidence",
                "stage": "error",
                "status": output.status,
                "request_id": request_id,
                "endpoint": endpoint,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
            }),
        );
    }
    if !state.debug.should_capture_snapshot_stage("client-response") && !force_error_evidence {
        return None;
    }
    match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => {
            let payload = state.debug.redact_payload_for_side_channel(json!({
                "object": "routecodex.v3.client_response_snapshot",
                "stage": "client-response",
                "source": "live_server_openai_chat_response",
                "status": output.status,
                "bodyKind": "json",
                "rawBody": value,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
            }));
            if let Err(error) = persist_v3_codex_sample_payload(
                state,
                entry_protocol,
                endpoint,
                request_id,
                "response.json",
                &payload,
            ) {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
        }
        V3OpenAiChatRelayClientBody::Sse(_) => {
            let body = std::mem::replace(
                &mut output.client_body,
                V3OpenAiChatRelayClientBody::Json(Value::Null),
            );
            let V3OpenAiChatRelayClientBody::Sse(stream) = body else {
                unreachable!("matched OpenAI Chat SSE client body");
            };
            let recorder = V3LiveSnapOpenAiChatClientResponseSseRecorder::new(
                Arc::clone(state),
                entry_protocol.to_string(),
                endpoint.to_string(),
                request_id.to_string(),
                output,
            );
            if let Err(error) = recorder.persist_initial() {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
            output.client_body = V3OpenAiChatRelayClientBody::Sse(recorder.wrap(stream));
        }
    }
    let _ = trace_scope;
    None
}

#[derive(Clone)]
struct V3LiveSnapOpenAiChatClientResponseSseRecorder {
    core: V3LiveSnapSseRecorderCore,
}

impl V3LiveSnapOpenAiChatClientResponseSseRecorder {
    fn new(
        state: Arc<V3ListenerState>,
        entry_protocol: String,
        endpoint: String,
        request_id: String,
        output: &V3OpenAiChatRelayRuntimeOutput,
    ) -> Self {
        Self {
            core: V3LiveSnapSseRecorderCore {
                state,
                entry_protocol,
                endpoint,
                request_id,
                status: output.status,
                node_trace: output.node_trace.clone(),
                error_chain: output.error_chain.clone(),
                observability: None,
                finalized_response: None,
                source: "live_server_openai_chat_stream",
                raw_sse: Arc::new(Mutex::new(V3DebugBoundedTextCapture::new())),
            },
        }
    }

    fn wrap(&self, stream: V3OpenAiChatClientStream) -> V3OpenAiChatClientStream {
        Box::pin(V3LiveSnapRecordedStream {
            inner: stream,
            recorder: self.core.clone(),
            terminal_persisted: false,
            error_message: |error: &String| error.clone(),
            map_error: |message: String| message,
            _phantom: std::marker::PhantomData,
        })
    }

    fn persist_initial(&self) -> Result<(), String> {
        self.core.persist_initial()
    }
}

fn capture_v3_responses_relay_provider_snapshots(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &mut V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    let force_error_evidence = output.status >= 400
        || output
            .observability
            .as_ref()
            .is_some_and(|observability| !observability.provider_failure_events.is_empty());
    if !state
        .debug
        .should_capture_snapshot_stage("provider-request")
        && !state
            .debug
            .should_capture_snapshot_stage("provider-response")
        && !force_error_evidence
    {
        return None;
    }
    let snapshots = output.provider_snapshots.as_mut()?;
    if let Some(provider_request) = snapshots.provider_request.take() {
        if force_error_evidence
            || state
                .debug
                .should_capture_snapshot_stage("provider-request")
        {
            let provider_request = state
                .debug
                .redact_payload_for_side_channel(provider_request);
            if let Err(error) = persist_v3_codex_sample_payload(
                state,
                entry_protocol,
                endpoint,
                request_id,
                "provider-request.json",
                &provider_request,
            ) {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3DebugProviderRequestCaptured",
                    V3DebugError::Sink(error),
                )));
            }
        }
    }
    if let Some(provider_response) = snapshots.provider_response.take() {
        if force_error_evidence
            || state
                .debug
                .should_capture_snapshot_stage("provider-response")
        {
            let provider_response = state
                .debug
                .redact_payload_for_side_channel(provider_response);
            if let Err(error) = persist_v3_codex_sample_payload(
                state,
                entry_protocol,
                endpoint,
                request_id,
                "provider-response.json",
                &provider_response,
            ) {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3DebugProviderResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
        }
    }
    None
}

fn finalize_v3_responses_relay_server_output(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    snapshot_session_id: Option<&str>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    mut output: V3ResponsesRelayRuntimeOutput,
    console_context: &V3ConsoleEmissionContext,
    started_at: Instant,
    request_console_project_path: Option<&str>,
    raw_request_payload: &Value,
) -> Response<Body> {
    let has_provider_failure = output
        .observability
        .as_ref()
        .is_some_and(|observability| !observability.provider_failure_events.is_empty());
    if output.status >= 400 || has_provider_failure {
        let _ = persist_v3_error_evidence_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "request.json",
            &state
                .debug
                .redact_payload_for_side_channel(raw_request_payload.clone()),
        );
        let _ = persist_v3_error_evidence_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "error.json",
            &json!({
                "object": "routecodex.v3.error_evidence",
                "stage": "error",
                "status": output.status,
                "request_id": request_id,
                "endpoint": endpoint,
                "node_trace": output.node_trace.clone(),
                "error_chain": output.error_chain.clone(),
                "observability": output.observability.as_ref().map(project_v3_runtime_observability_debug),
            }),
        );
    }
    if let Some(response) = capture_v3_responses_relay_provider_snapshots(
        state,
        entry_protocol,
        endpoint,
        request_id,
        &mut output,
    ) {
        return response;
    }
    if let Some(response) = capture_v3_responses_relay_response(
        state,
        trace_scope,
        entry_protocol,
        endpoint,
        request_id,
        &mut output,
    ) {
        return response;
    }
    if let Some(response) = record_v3_live_snapshot_projection(
        state,
        trace_scope,
        snapshot_session_id,
        output.status,
        &output.node_trace,
        "live_response",
    ) {
        return response;
    }
    if let Some(error_chain) = output.error_chain.as_deref() {
        if let Some(response) = record_and_emit_v3_error_projection(
            state,
            trace_scope,
            V3ErrorProjectionConsoleInput {
                endpoint,
                request_id,
                status: output.status,
                error_chain,
                body: relay_error_body_for_console(&output.client_body),
                project_path: request_console_project_path,
            },
        ) {
            return response;
        }
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
            console_context,
            output.status,
            &output.node_trace,
            observability,
            started_at,
            output.stream_observation.is_none(),
        );
    }
    responses_relay_output_response(
        output,
        stream_console_finalizer,
        Duration::from_millis(state.server.http_sse_keepalive_ms),
    )
}

fn capture_v3_responses_direct_response(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    frame: &mut V3Server16HttpFrame,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response")
        || !v3_codex_sample_scope_allows(state, V3EntryProtocolExecutionMode::Direct)
    {
        return None;
    }
    let payload = match &frame.body {
        V3Server16Body::Json(value) => value.clone(),
        V3Server16Body::Bytes(bytes) => json!({
            "object": "routecodex.v3.client_response_snapshot",
            "stage": "client-response",
            "source": "live_server_direct_response_bytes",
            "status": frame.status,
            "bodyKind": "bytes",
            "rawBody": String::from_utf8_lossy(bytes),
            "node_trace": frame.node_trace.clone(),
            "error_chain": frame.error_chain.clone(),
            "observability": frame.observability.as_ref().map(project_v3_runtime_observability_debug),
        }),
        V3Server16Body::Sse(_) => {
            let body = std::mem::replace(&mut frame.body, V3Server16Body::Bytes(Vec::new()));
            let V3Server16Body::Sse(stream) = body else {
                unreachable!("matched Direct SSE client body");
            };
            let recorder = V3LiveSnapDirectClientResponseSseRecorder::new(
                Arc::clone(state),
                entry_protocol.to_string(),
                endpoint.to_string(),
                request_id.to_string(),
                frame,
            );
            if let Err(error) = recorder.persist_initial() {
                return Some(foundation_output_response(project_v3_debug_failure(
                    "V3Debug03RawResponseCaptured",
                    V3DebugError::Sink(error),
                )));
            }
            frame.body = V3Server16Body::Sse(recorder.wrap(stream));
            return None;
        }
    };
    let payload = state.debug.redact_payload_for_side_channel(payload);
    if let Err(error) = persist_v3_codex_sample_payload(
        state,
        entry_protocol,
        endpoint,
        request_id,
        "response.json",
        &payload,
    ) {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3Debug03RawResponseCaptured",
            V3DebugError::Sink(error),
        )));
    }
    None
}

fn capture_v3_foundation_runtime_response(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    entry_protocol: &str,
    execution_mode: V3EntryProtocolExecutionMode,
    endpoint: &str,
    request_id: &str,
    output: &V3FoundationRuntimeOutput,
) -> Option<Response<Body>> {
    if !state.debug.should_capture_snapshot_stage("client-response") {
        return None;
    }
    if entry_protocol == "responses" && execution_mode == V3EntryProtocolExecutionMode::Direct {
        if !v3_codex_sample_scope_allows(state, execution_mode) {
            return None;
        }
        let payload = state
            .debug
            .redact_payload_for_side_channel(output.body.clone());
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "response.json",
            &payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                V3DebugError::Sink(error),
            )));
        }
        return None;
    }
    let projection = match state
        .debug
        .capture_raw_response(trace_scope, output.body.clone())
    {
        Ok(projection) => projection,
        Err(error) => {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                error,
            )));
        }
    };
    if let Some(projection) = projection {
        if let Err(error) = persist_v3_codex_sample_payload(
            state,
            entry_protocol,
            endpoint,
            request_id,
            "response.json",
            &projection.payload,
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3Debug03RawResponseCaptured",
                V3DebugError::Sink(error),
            )));
        }
    }
    None
}

fn project_v3_runtime_observability_debug(observability: &V3RuntimeObservability) -> Value {
    json!({
        "routing_group_id": observability.routing_group_id,
        "pool_id": observability.pool_id,
        "provider_id": observability.provider_id,
        "provider_key": observability.provider_key,
        "model_id": observability.model_id,
        "wire_model": observability.wire_model,
        "provider_type": observability.provider_type,
        "attempts": observability.attempts,
        "transport": observability.transport,
        "provider_status": observability.provider_status,
        "response_status": observability.response_status,
        "finish_reason": observability.finish_reason,
        "stopless_activation": observability.stopless_activation,
        "target_path": observability.target_path,
        "unavailable_candidates": observability.unavailable_candidates,
        "provider_failure_events": observability.provider_failure_events.iter().map(project_v3_runtime_provider_failure_event_debug).collect::<Vec<Value>>(),
        "usage": observability.usage.as_ref().map(project_v3_runtime_usage_debug),
    })
}

fn project_v3_runtime_provider_failure_event_debug(
    event: &V3RuntimeProviderFailureObservation,
) -> Value {
    json!({
        "provider_key": &event.provider_key,
        "provider_id": &event.provider_id,
        "auth_alias": event.auth_alias.as_ref(),
        "model_id": &event.model_id,
        "status": event.status,
        "error_type": event.error_type.as_ref(),
        "external_error_kind": event.external_error_kind.as_ref(),
        "external_error_code": event.external_error_code.as_ref(),
        "external_error_status": event.external_error_status,
        "internal_code": event.internal_code.as_ref(),
        "message": &event.message,
        "failure_count": event.failure_count,
        "health_state": &event.health_state,
        "cooldown_until_ms": event.cooldown_until_ms,
        "action": &event.action,
        "next_provider_key": event.next_provider_key.as_ref(),
        "wait_ms": event.wait_ms,
    })
}

fn project_v3_runtime_usage_debug(usage: &V3RuntimeUsageSummary) -> Value {
    json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "cached_tokens": usage.cached_tokens,
    })
}

fn persist_v3_codex_sample_payload(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    file_name: &str,
    payload: &Value,
) -> Result<(), String> {
    state.codex_sample_store.persist(
        state.server.port,
        entry_protocol,
        endpoint,
        request_id,
        file_name,
        payload,
        false,
    )
}

fn persist_v3_error_evidence_payload(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    file_name: &str,
    payload: &Value,
) -> Result<(), String> {
    state.codex_sample_store.persist(
        state.server.port,
        entry_protocol,
        endpoint,
        request_id,
        file_name,
        payload,
        true,
    )
}

fn v3_codex_sample_scope_allows(
    state: &V3ListenerState,
    execution_mode: V3EntryProtocolExecutionMode,
) -> bool {
    state.codex_sample_store.is_enabled()
        && (execution_mode != V3EntryProtocolExecutionMode::Direct
            || state.manifest.debug.snapshot_direct)
}

fn start_v3_live_snapshot_session(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
) -> Result<Option<String>, Box<Response<Body>>> {
    match state.debug.start_snapshot_session(trace_scope, "live") {
        Ok(session_id) => Ok(Some(session_id)),
        Err(V3DebugError::Disabled("snapshots")) => Ok(None),
        Err(error) => Err(Box::new(foundation_output_response(
            project_v3_debug_failure("V3SnapshotSessionStarted", error),
        ))),
    }
}

fn record_v3_live_snapshot_projection(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    snapshot_session_id: Option<&str>,
    status: u16,
    node_trace: &[&'static str],
    phase: &'static str,
) -> Option<Response<Body>> {
    let session_id = snapshot_session_id?;
    for node_id in node_trace {
        if let Err(error) = state.debug.record_snapshot(
            trace_scope,
            session_id,
            *node_id,
            json!({
                "node_id": node_id,
                "phase": phase,
                "status": status,
                "live": true
            }),
        ) {
            return Some(foundation_output_response(project_v3_debug_failure(
                "V3SnapshotNodeCaptured",
                error,
            )));
        }
    }
    if let Err(error) = state
        .debug
        .close_snapshot_session_keep_snapshots(trace_scope, session_id)
    {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3SnapshotSessionClosed",
            error,
        )));
    }
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

#[derive(Clone)]
struct V3ConsoleEmissionContext {
    state: Arc<V3ListenerState>,
    entry_protocol: String,
    endpoint: String,
    request_identity: V3AllocatedRequestIdentity,
    identity: V3ConsoleLogIdentity,
    realtime_provider_failure_event_keys: Arc<Mutex<BTreeSet<String>>>,
    realtime_route_selection_keys: Arc<Mutex<BTreeSet<String>>>,
}

fn build_v3_console_emission_context(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_identity: &V3AllocatedRequestIdentity,
    headers: &HeaderMap,
    payload: &Value,
) -> V3ConsoleEmissionContext {
    let identity = resolve_v3_console_log_identity_from_parts(
        headers,
        payload,
        &request_identity.request_id,
    );
    V3ConsoleEmissionContext {
        state: Arc::clone(state),
        entry_protocol: entry_protocol.to_string(),
        endpoint: endpoint.to_string(),
        request_identity: request_identity.clone(),
        identity,
        realtime_provider_failure_event_keys: Arc::new(Mutex::new(BTreeSet::new())),
        realtime_route_selection_keys: Arc::new(Mutex::new(BTreeSet::new())),
    }
}

fn emit_v3_provider_observability_console_lines(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    for event in &observability.provider_failure_events {
        emit_v3_provider_failure_console_event(context, observability, event);
    }
    if observability.provider_failure_events.is_empty()
        && !observability.unavailable_candidates.is_empty()
    {
        let selected = format_v3_console_provider_target(observability);
        let content = format_v3_console_timed_content(
            "[provider-unavailable]",
            &format!(
                "req={} unavailable={} selected={} reason=availability",
                context.request_identity.request_id,
                observability.unavailable_candidates.join(","),
                selected
            ),
        );
        emit_v3_colorized_request_console_line(
            &context.state,
            &content,
            &content,
            identity.color_key.as_deref(),
            &format_v3_console_human_prefix_for_observability(
                &context.state.server.port.to_string(),
                &context.entry_protocol,
                identity.project_path.as_deref(),
                observability,
                &route.label,
            ),
            &identity.session_id,
        );
    }
}

fn build_v3_route_selection_event_sink(
    context: &V3ConsoleEmissionContext,
) -> V3RuntimeRouteSelectionEventSink {
    let context = context.clone();
    Arc::new(move |observability| {
        emit_v3_request_route_hit_console_line_for_observability(&context, observability);
    })
}

fn has_v3_realtime_route_selection_console_event(context: &V3ConsoleEmissionContext) -> bool {
    !context
        .realtime_route_selection_keys
        .lock()
        .expect("V3 console route-selection dedupe mutex poisoned")
        .is_empty()
}

fn mark_v3_route_selection_console_event_once(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) -> bool {
    let key = format_v3_route_selection_console_event_key(observability);
    context
        .realtime_route_selection_keys
        .lock()
        .expect("V3 console route-selection dedupe mutex poisoned")
        .insert(key)
}

fn format_v3_route_selection_console_event_key(observability: &V3RuntimeObservability) -> String {
    format!(
        "{}|{}|{}|{}",
        observability.routing_group_id.as_deref().unwrap_or("-"),
        observability.pool_id.as_deref().unwrap_or("-"),
        observability.provider_key.as_deref().unwrap_or("-"),
        observability.model_id.as_deref().unwrap_or("-")
    )
}

fn build_v3_provider_failure_event_sink(
    context: &V3ConsoleEmissionContext,
) -> V3RuntimeProviderFailureEventSink {
    let context = context.clone();
    Arc::new(move |observability, event| {
        emit_v3_provider_failure_console_event(&context, observability, event);
    })
}

fn emit_v3_provider_failure_console_event(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    event: &V3RuntimeProviderFailureObservation,
) {
    if !context.state.console_enabled {
        return;
    }
    if !mark_v3_provider_failure_console_event_once(context, event) {
        return;
    }
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let event_observability =
        build_v3_console_provider_failure_event_observability(observability, event);
    let error_content =
        format_v3_provider_failure_console_content(&context.request_identity.request_id, event);
    let error_content_str = error_content.as_str();
    let error_human_prefix = format_v3_console_human_prefix_for_observability(
        &context.state.server.port.to_string(),
        &context.entry_protocol,
        identity.project_path.as_deref(),
        &event_observability,
        &route.label,
    );
    let colorized_error = colorize_v3_error_console_line(
        &error_human_prefix,
        error_content_str,
        error_content_str,
        &identity.session_id,
    );
    append_v3_human_console_line(&context.state, &colorized_error);
    eprintln!("{colorized_error}");
    if event.action == "switch_provider" {
        let switch_content =
            format_v3_provider_switch_console_content(&context.request_identity.request_id, event);
        let switch_content_str = switch_content.as_str();
        emit_v3_colorized_request_console_line(
            &context.state,
            switch_content_str,
            switch_content_str,
            identity.color_key.as_deref(),
            &format_v3_console_human_prefix_for_observability(
                &context.state.server.port.to_string(),
                &context.entry_protocol,
                identity.project_path.as_deref(),
                &event_observability,
                &route.label,
            ),
            &identity.session_id,
        );
    }
}

fn mark_v3_provider_failure_console_event_once(
    context: &V3ConsoleEmissionContext,
    event: &V3RuntimeProviderFailureObservation,
) -> bool {
    let key = format_v3_provider_failure_console_event_key(event);
    context
        .realtime_provider_failure_event_keys
        .lock()
        .expect("V3 console provider-failure dedupe mutex poisoned")
        .insert(key)
}

fn format_v3_provider_failure_console_event_key(
    event: &V3RuntimeProviderFailureObservation,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        event.provider_key,
        event.status,
        event.failure_count,
        event.health_state,
        event.action,
        event.next_provider_key.as_deref().unwrap_or("-"),
        event.message
    )
}

fn build_v3_console_provider_failure_event_observability(
    observability: &V3RuntimeObservability,
    event: &V3RuntimeProviderFailureObservation,
) -> V3RuntimeObservability {
    let mut event_observability = observability.clone();
    event_observability.provider_id = Some(event.provider_id.clone());
    event_observability.auth_alias = event.auth_alias.clone();
    event_observability.provider_key = Some(event.provider_key.clone());
    event_observability.model_id = Some(event.model_id.clone());
    event_observability.wire_model = Some(event.model_id.clone());
    event_observability.provider_status = Some(event.status);
    event_observability
}

fn format_v3_provider_failure_console_content(
    request_id: &str,
    event: &V3RuntimeProviderFailureObservation,
) -> String {
    let provider = format_v3_console_provider_key_label(&event.provider_key);
    let next = event
        .next_provider_key
        .as_deref()
        .map(format_v3_console_provider_key_label)
        .unwrap_or_else(|| "-".to_string());
    let mut fields = if event.action == "switch_provider" && event.next_provider_key.is_some() {
        format!(
            "req={} [switch to:{}] [switch from:{}] result={} causeStatus={} failures={} health={}",
            request_id,
            next,
            provider,
            event.action,
            event.status,
            event.failure_count,
            event.health_state
        )
    } else {
        format!(
            "req={} target={} result={} next={} causeStatus={} failures={} health={}",
            request_id,
            provider,
            event.action,
            next,
            event.status,
            event.failure_count,
            event.health_state
        )
    };
    if let Some(cooldown_until_ms) = event.cooldown_until_ms {
        fields.push_str(&format!(" cooldownUntilMs={cooldown_until_ms}"));
    }
    if let Some(wait_ms) = event.wait_ms {
        fields.push_str(&format!(" waitMs={wait_ms}"));
    }
    if let Some(error_type) = event.error_type.as_deref() {
        fields.push_str(&format!(" type={error_type}"));
    }
    if let Some(external_error_kind) = event.external_error_kind.as_deref() {
        fields.push_str(&format!(" external={external_error_kind}"));
    }
    if let Some(external_error_code) = event.external_error_code.as_deref() {
        fields.push_str(&format!(" externalCode={external_error_code}"));
    }
    if let Some(external_error_status) = event.external_error_status {
        fields.push_str(&format!(" externalStatus={external_error_status}"));
    }
    if let Some(internal_code) = event.internal_code.as_deref() {
        fields.push_str(&format!(" internalCode={internal_code}"));
    }
    fields.push_str(&format!(
        " message={}",
        format_v3_console_single_line_message(&event.message)
    ));
    format_v3_console_timed_content("❌ [provider-error]", &fields)
}

fn format_v3_provider_switch_console_content(
    request_id: &str,
    event: &V3RuntimeProviderFailureObservation,
) -> String {
    let from = format_v3_console_provider_key_label(&event.provider_key);
    let target = event
        .next_provider_key
        .as_deref()
        .map(format_v3_console_provider_key_label)
        .unwrap_or_else(|| "-".to_string());
    format_v3_console_timed_content(
        "[provider-switch]",
        &format!(
            "req={} [switch to:{}] [switch from:{}] result={} reason=provider_failure causeStatus={} failures={} health={} message={}",
            request_id, target, from, event.action, event.status, event.failure_count, event.health_state, event.message
        ),
    )
}

struct V3ConsoleRequestHeadline<'a> {
    endpoint: &'a str,
    route: &'a str,
    target: &'a str,
    reason: &'a str,
    request_identity: &'a V3AllocatedRequestIdentity,
}

fn render_v3_request_console_block(headline: &V3ConsoleRequestHeadline<'_>) -> String {
    format_v3_console_timed_content(
        &format!("▶ [{}]", headline.endpoint),
        &format!(
            "{} route={} target={} reason={}",
            format_v3_console_request_count(headline.request_identity),
            headline.route,
            headline.target,
            headline.reason
        ),
    )
}

struct V3ConsoleResponseHeadline<'a> {
    endpoint: &'a str,
    status: u16,
    response_status: &'a str,
    finish_reason: &'a str,
    elapsed_ms: f64,
    reason: &'a str,
    usage: Option<&'a str>,
    internal_timing: &'a str,
    external_timing: &'a str,
    transport: &'a str,
    request_identity: &'a V3AllocatedRequestIdentity,
}

fn render_v3_response_console_block(headline: &V3ConsoleResponseHeadline<'_>) -> String {
    let mut fields = format!(
        "{} status={} responseStatus={} finish_reason={} elapsedMs={:.1} reason={}",
        format_v3_console_request_count(headline.request_identity),
        headline.status,
        headline.response_status,
        headline.finish_reason,
        headline.elapsed_ms,
        headline.reason,
    );
    if let Some(usage) = headline.usage.filter(|value| !value.is_empty()) {
        fields.push(' ');
        fields.push_str(usage);
    }
    fields.push_str(&format!(
        " time_i={} time_e={} time_t={:.1}ms transport={}",
        headline.internal_timing, headline.external_timing, headline.elapsed_ms, headline.transport
    ));
    format_v3_console_timed_content(&format!("✅ [{}]", headline.endpoint), &fields)
}

fn format_v3_console_request_count(identity: &V3AllocatedRequestIdentity) -> String {
    align_v3_console_display_width(
        &format!("[#{}/{}]", identity.total_count, identity.daily_count),
        V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH,
    )
}

fn emit_v3_request_route_hit_console_line_for_observability(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    if !mark_v3_route_selection_console_event_once(context, observability) {
        return;
    }
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let provider_target = format_v3_console_provider_target(observability);
    let headline = render_v3_request_console_block(&V3ConsoleRequestHeadline {
        endpoint: &context.endpoint,
        route: &route.label,
        target: &provider_target,
        reason: &route.reason,
        request_identity: &context.request_identity,
    });
    let debug = format_v3_console_timed_content(
        "[virtual-router-hit]",
        &format!(
            "req={} event=route_selected route={} target={} reason={}",
            context.request_identity.request_id, route.label, provider_target, route.reason
        ),
    );
    emit_v3_colorized_request_console_line(
        &context.state,
        headline.as_str(),
        debug.as_str(),
        identity.color_key.as_deref(),
        &format_v3_console_human_prefix_for_observability(
            &context.state.server.port.to_string(),
            &context.entry_protocol,
            identity.project_path.as_deref(),
            observability,
            &route.label,
        ),
        &identity.session_id,
    );
}

fn emit_v3_request_complete_console_line(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    elapsed: std::time::Duration,
) -> Result<(), String> {
    if !context.state.console_enabled {
        return Ok(());
    }
    let response_status = observability
        .response_status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "successful V3 Runtime observability is missing response_status".to_string()
        })?;
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| infer_v3_console_finish_reason_from_response_status(Some(response_status)))
        .ok_or_else(|| {
            "successful V3 Runtime observability is missing finish_reason".to_string()
        })?;
    let human_usage = format_v3_console_human_usage_summary(observability.usage.as_ref());
    let debug_usage = format_v3_console_usage_summary(observability.usage.as_ref());
    let route = resolve_v3_console_route_projection(observability);
    let (internal_timing, external_timing) =
        format_v3_console_runtime_timing(observability.timing.as_ref())?;
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    let identity = context.identity.clone();
    let headline = render_v3_response_console_block(&V3ConsoleResponseHeadline {
        endpoint: &context.endpoint,
        status,
        response_status,
        finish_reason: finish_reason.as_str(),
        elapsed_ms,
        reason: &route.reason,
        usage: human_usage.as_deref(),
        internal_timing: &internal_timing,
        external_timing: &external_timing,
        transport: &observability.transport,
        request_identity: &context.request_identity,
    });
    let debug = format_v3_console_timed_content(
        &format!("✅ [{}]", context.endpoint),
        &format!(
            "req={} event=completed detail=[usage] status={}{} responseStatus={} finish_reason={} elapsedMs={:.1} reason={} {} time_i={} time_e={} time_t={:.1}ms nodes={} transport={}",
            context.request_identity.request_id,
            status,
            format_v3_console_upstream_status_suffix(status, observability.provider_status),
            response_status,
            finish_reason,
            elapsed_ms,
            route.reason,
            debug_usage,
            internal_timing,
            external_timing,
            elapsed_ms,
            node_trace.len(),
            observability.transport
        ),
    );
    emit_v3_colorized_request_console_line(
        &context.state,
        headline.as_str(),
        debug.as_str(),
        identity.color_key.as_deref(),
        &format_v3_console_human_prefix_for_observability(
            &context.state.server.port.to_string(),
            &context.entry_protocol,
            identity.project_path.as_deref(),
            observability,
            &route.label,
        ),
        &identity.session_id,
    );
    Ok(())
}

fn format_v3_console_runtime_timing(
    timing: Option<&V3RuntimeTimingSummary>,
) -> Result<(String, String), String> {
    let timing = timing
        .ok_or_else(|| "successful V3 Runtime observability is missing timing".to_string())?;
    if timing.internal.checked_add(timing.external) != Some(timing.runtime_total) {
        return Err("V3 Runtime timing identity is invalid".to_string());
    }
    Ok((
        format!("{:.1}ms", timing.internal.as_secs_f64() * 1000.0),
        format!("{:.1}ms", timing.external.as_secs_f64() * 1000.0),
    ))
}

fn emit_v3_runtime_observability_contract_failure(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    error: impl Into<String>,
) {
    let source = raise_v3_runtime_observability_contract_failure(error);
    emit_v3_post_commit_sse_source_console_line_for_context(context, observability, 500, &source);
}

fn emit_v3_stopless_console_line(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled || !is_v3_stopless_console_activation(observability) {
        return;
    }
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .expect("Stopless console activation requires a typed finish reason");
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let content = format_v3_console_timed_content(
        "🧭 [stopless]",
        &format!(
            "req={} event=activated hook=reasoningStop callId=call_stopless_reasoning action=exec_command finish_reason={} transport={}",
            context.request_identity.request_id, finish_reason, observability.transport
        ),
    );
    let content_str = content.as_str();
    let stopless_human_prefix = format_v3_console_human_prefix_for_observability(
        &context.state.server.port.to_string(),
        &context.entry_protocol,
        identity.project_path.as_deref(),
        observability,
        &route.label,
    );
    let colorized = colorize_v3_stopless_console_line(
        &stopless_human_prefix,
        content_str,
        content_str,
        &identity.session_id,
    );
    append_v3_human_console_line(&context.state, &colorized);
    println!("{colorized}");
}

fn is_v3_stopless_console_activation(observability: &V3RuntimeObservability) -> bool {
    observability.stopless_activation
}

fn append_v3_human_console_line(state: &V3ListenerState, line: &str) {
    if let Err(error) = state.debug.append_human_console_line(line) {
        emit_v3_debug_sink_console_failure(state, &error);
    }
}

fn emit_v3_debug_sink_console_failure(state: &V3ListenerState, error: &V3DebugError) {
    let debug_msg = format!(
        "{} ❌ {} request debug-log failed (status=500 error=V3E00 subcode=debug_sink node=V3DebugEventLedgerRecorded) {}",
        format_v3_console_human_prefix(
            &state.server.port.to_string(),
            "debug",
            None,
            "-",
            "-",
        ),
        console_timestamp_hhmmss(),
        error
    );
    eprintln!(
        "{}",
        colorize_v3_error_console_line("", &debug_msg, &debug_msg, "-")
    );
}

fn emit_v3_colorized_request_console_line(
    state: &V3ListenerState,
    headline: &str,
    debug: &str,
    color_key: Option<&str>,
    human_prefix: &str,
    session_id: &str,
) {
    let colorized =
        colorize_v3_request_console_line(human_prefix, headline, debug, color_key, session_id);
    append_v3_human_console_line(state, &colorized);
    println!("{colorized}");
}

fn emit_v3_observability_console_lines(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    started_at: Instant,
    include_usage: bool,
) {
    if !has_v3_realtime_route_selection_console_event(context) {
        emit_v3_request_route_hit_console_line_for_observability(context, observability);
    }
    emit_v3_provider_observability_console_lines(context, observability);
    if include_usage {
        let elapsed = started_at.elapsed();
        emit_v3_stopless_console_line(context, observability);
        if should_emit_v3_request_complete_console_line(status, observability) {
            if let Err(error) = emit_v3_request_complete_console_line(
                context,
                status,
                node_trace,
                observability,
                elapsed,
            ) {
                emit_v3_runtime_observability_contract_failure(context, observability, error);
            }
        }
    }
}

fn emit_v3_direct_frame_console_lines(
    context: &V3ConsoleEmissionContext,
    frame: &V3Server16HttpFrame,
    started_at: Instant,
) -> Option<V3DirectSseConsoleFinalizer> {
    let mut observability = frame.observability.clone();
    if let Some(observability) = observability.as_mut() {
        enrich_v3_direct_observability_from_frame(observability, frame);
        emit_v3_frame_error_console_line_for_context(context, frame, observability);
    } else {
        let identity = context.identity.clone();
        emit_v3_frame_error_console_line_for_state(
            &context.state,
            &context.endpoint,
            &context.request_identity.request_id,
            frame,
            identity.project_path.as_deref(),
        );
    }
    let observability = observability?;
    let is_sse = matches!(frame.body, V3Server16Body::Sse(_));
    emit_v3_observability_console_lines(
        context,
        frame.status,
        &frame.node_trace,
        &observability,
        started_at,
        !is_sse,
    );
    is_sse.then(|| V3DirectSseConsoleFinalizer {
        context: context.clone(),
        status: frame.status,
        node_trace: frame.node_trace.clone(),
        observability,
        stream_observation: frame.stream_observation.clone(),
        started_at,
    })
}

fn enrich_v3_direct_observability_from_frame(
    observability: &mut V3RuntimeObservability,
    frame: &V3Server16HttpFrame,
) {
    observability.transport = match &frame.body {
        V3Server16Body::Json(_) => "json",
        V3Server16Body::Bytes(_) => "bytes",
        V3Server16Body::Sse(_) => "sse",
    }
    .to_string();
    observability.provider_status = observability.provider_status.or(Some(frame.status));
    let V3Server16Body::Json(body) = &frame.body else {
        return;
    };
    if let Some(status) = read_v3_console_response_status(body) {
        observability.response_status = Some(status);
    }
    if let Some(finish_reason) = read_v3_console_finish_reason(body) {
        observability.finish_reason = Some(finish_reason);
    } else if observability.finish_reason.is_none() {
        observability.finish_reason = infer_v3_console_finish_reason_from_response_status(
            observability.response_status.as_deref(),
        );
    }
    if let Some(usage) = extract_v3_console_usage_summary(body) {
        observability.usage = Some(usage);
    }
}

fn should_emit_v3_request_complete_console_line(
    status: u16,
    observability: &V3RuntimeObservability,
) -> bool {
    if status >= 400 {
        return false;
    }
    !matches!(
        observability.response_status.as_deref(),
        Some("error" | "failed" | "incomplete")
    )
}

fn format_v3_console_upstream_status_suffix(
    response_status: u16,
    provider_status: Option<u16>,
) -> String {
    match provider_status {
        Some(upstream_status) if upstream_status != response_status => {
            format!(" upstreamStatus={upstream_status}")
        }
        _ => String::new(),
    }
}

struct V3SseConsoleFinalizer {
    context: V3ConsoleEmissionContext,
    status: u16,
    node_trace: Vec<&'static str>,
    observability: V3RuntimeObservability,
    stream_observation: V3RuntimeStreamObservation,
    started_at: Instant,
}

struct V3DirectSseConsoleFinalizer {
    context: V3ConsoleEmissionContext,
    status: u16,
    node_trace: Vec<&'static str>,
    observability: V3RuntimeObservability,
    stream_observation: Option<V3RuntimeStreamObservation>,
    started_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum V3SseConsoleStreamTerminal {
    Completed,
    Dropped,
}

impl V3SseConsoleFinalizer {
    fn complete_relay_sse(mut self) {
        if let Err(error) = merge_v3_runtime_stream_observation(
            &mut self.observability,
            Some(&self.stream_observation),
        ) {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_relay_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.provider_stream_missing_terminal();
    }

    fn emit_relay_sse_complete_console_lines(self) {
        let elapsed = self.started_at.elapsed();
        emit_v3_stopless_console_line(&self.context, &self.observability);
        if let Err(error) = emit_v3_request_complete_console_line(
            &self.context,
            self.status,
            &self.node_trace,
            &self.observability,
            elapsed,
        ) {
            emit_v3_runtime_observability_contract_failure(
                &self.context,
                &self.observability,
                error,
            );
        }
    }

    fn provider_stream_failed(self, error: &str) {
        self.emit_relay_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure("provider_response_sse_stream", error),
        );
    }

    fn provider_stream_missing_terminal(self) {
        self.provider_stream_failed("provider response SSE stream ended before terminal event");
    }

    fn provider_stream_terminal_failed(self, status: &str) {
        self.emit_relay_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure(
                "provider_response_sse_terminal_failure",
                format!("response SSE stream ended with terminal status {status}"),
            ),
        );
    }

    fn client_disconnected(mut self) {
        if let Err(error) = merge_v3_runtime_stream_observation(
            &mut self.observability,
            Some(&self.stream_observation),
        ) {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_relay_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.emit_relay_sse_failure_console_line(499, raise_v3_sse_client_disconnect());
    }

    fn emit_relay_sse_failure_console_line(self, status: u16, source: V3Error01SourceRaised) {
        emit_v3_post_commit_sse_source_console_line_for_context(
            &self.context,
            &self.observability,
            status,
            &source,
        );
    }
}

impl V3DirectSseConsoleFinalizer {
    fn complete(mut self) {
        if let Err(error) = self.merge_stream_observation() {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                self.emit_direct_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.provider_stream_missing_terminal();
    }

    fn emit_direct_sse_complete_console_lines(self) {
        let elapsed = self.started_at.elapsed();
        emit_v3_stopless_console_line(&self.context, &self.observability);
        if should_emit_v3_request_complete_console_line(self.status, &self.observability) {
            if let Err(error) = emit_v3_request_complete_console_line(
                &self.context,
                self.status,
                &self.node_trace,
                &self.observability,
                elapsed,
            ) {
                emit_v3_runtime_observability_contract_failure(
                    &self.context,
                    &self.observability,
                    error,
                );
            }
        }
    }

    fn provider_stream_failed(self, error: &str) {
        self.emit_direct_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure("provider_response_sse_stream", error),
        );
    }

    fn provider_stream_missing_terminal(self) {
        self.provider_stream_failed("provider response SSE stream ended before terminal event");
    }

    fn provider_stream_terminal_failed(self, status: &str) {
        self.emit_direct_sse_failure_console_line(
            502,
            raise_v3_sse_provider_failure(
                "provider_response_sse_terminal_failure",
                format!("response SSE stream ended with terminal status {status}"),
            ),
        );
    }

    fn client_disconnected(mut self) {
        if let Err(error) = self.merge_stream_observation() {
            self.provider_stream_failed(&error);
            return;
        }
        if let Some(status) = self.observability.response_status.clone() {
            if is_v3_sse_terminal_success_status(&status) {
                if self.observability.timing.is_none() {
                    return;
                }
                self.emit_direct_sse_complete_console_lines();
                return;
            }
            if is_v3_sse_terminal_failure_status(&status) {
                self.provider_stream_terminal_failed(&status);
                return;
            }
        }
        self.emit_direct_sse_failure_console_line(499, raise_v3_sse_client_disconnect());
    }

    fn merge_stream_observation(&mut self) -> Result<(), String> {
        merge_v3_runtime_stream_observation(
            &mut self.observability,
            self.stream_observation.as_ref(),
        )
    }

    fn emit_direct_sse_failure_console_line(self, status: u16, source: V3Error01SourceRaised) {
        emit_v3_post_commit_sse_source_console_line_for_context(
            &self.context,
            &self.observability,
            status,
            &source,
        );
    }
}

fn emit_v3_post_commit_sse_source_console_line_for_context(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    status: u16,
    source: &V3Error01SourceRaised,
) {
    let projected = project_v3_post_commit_sse_source(source.clone(), status);
    emit_v3_error_console_line_for_context(
        context,
        observability,
        projected.status,
        &projected.chain,
        Some(&projected.body),
    );
}

fn merge_v3_runtime_stream_observation(
    observability: &mut V3RuntimeObservability,
    observation: Option<&V3RuntimeStreamObservation>,
) -> Result<(), String> {
    if let Some(observation) = observation {
        let snapshot = observation.snapshot()?;
        if snapshot.response_status.is_some() {
            observability.response_status = snapshot.response_status;
        }
        if snapshot.finish_reason.is_some() {
            observability.finish_reason = snapshot.finish_reason;
        }
        if snapshot.usage.is_some() {
            observability.usage = snapshot.usage;
        }
        if snapshot.timing.is_some() {
            observability.timing = snapshot.timing;
        }
    }
    Ok(())
}

fn is_v3_sse_terminal_success_status(status: &str) -> bool {
    matches!(status.trim(), "completed" | "requires_action" | "done")
}

fn is_v3_sse_terminal_failure_status(status: &str) -> bool {
    matches!(
        status.trim(),
        "failed" | "incomplete" | "cancelled" | "canceled" | "error"
    )
}

#[derive(Debug, Clone)]
struct V3ConsoleLogIdentity {
    color_key: Option<String>,
    session_id: String,
    project_path: Option<String>,
}

fn resolve_v3_console_log_identity_from_parts(
    headers: &HeaderMap,
    payload: &Value,
    request_id: &str,
) -> V3ConsoleLogIdentity {
    let turn_metadata = parse_codex_turn_metadata(headers).ok().flatten();
    let session_id = first_header_text(
        headers,
        &[
            "session-id",
            "session_id",
            "x-session-id",
            "x-routecodex-session-id",
            "x-rcc-session-id",
        ],
    )
    .ok()
    .flatten()
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
            "x-routecodex-conversation-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    let project_path =
        resolve_v3_console_project_path_with_metadata(headers, payload, turn_metadata.as_ref());
    let color_key = resolve_v3_log_session_color_key(headers, payload, request_id);
    let session_display = session_id
        .or(conversation_id)
        .or_else(|| color_key.clone())
        .unwrap_or_else(|| format!("request:{}", format_v3_usage_request_id(request_id)));
    V3ConsoleLogIdentity {
        color_key,
        session_id: format_v3_console_safe_label(&session_display),
        project_path,
    }
}

fn resolve_v3_console_project_path(headers: &HeaderMap, payload: &Value) -> Option<String> {
    let turn_metadata = parse_codex_turn_metadata(headers).ok().flatten();
    resolve_v3_console_project_path_with_metadata(headers, payload, turn_metadata.as_ref())
}

fn resolve_v3_console_project_path_with_metadata(
    headers: &HeaderMap,
    payload: &Value,
    turn_metadata: Option<&Value>,
) -> Option<String> {
    first_header_text(
        headers,
        &["x-routecodex-workdir", "x-rcc-workdir", "x-workdir"],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata, TURN_METADATA_WORKDIR_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_WORKDIR_PATHS))
    .or_else(|| read_v3_environment_context_cwd_from_payload(payload))
        .or_else(|| console::read_injected_workspace_cwd_from_payload(payload))
}

fn read_v3_environment_context_cwd_from_payload(payload: &Value) -> Option<String> {
    for item in payload.get("input").and_then(Value::as_array)? {
        let Some(parts) = item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for text in parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
        {
            if let Some(cwd) = read_v3_environment_context_cwd_from_text(text) {
                return Some(cwd);
            }
        }
    }
    None
}

fn read_v3_environment_context_cwd_from_text(text: &str) -> Option<String> {
    let start = text.find("<environment_context>")?;
    let tail = &text[start..];
    let cwd_start = tail.find("<cwd>")? + "<cwd>".len();
    let cwd_tail = &tail[cwd_start..];
    let cwd_end = cwd_tail.find("</cwd>")?;
    let cwd = cwd_tail[..cwd_end].trim();
    if cwd.is_empty() {
        None
    } else {
        Some(cwd.to_string())
    }
}

fn format_v3_console_human_prefix(
    port_label: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
    model_scope: &str,
    route_scope: &str,
) -> String {
    let model = format_v3_console_safe_label(model_scope);
    let route = format_v3_console_safe_label(route_scope);
    let route_model = match (route.as_str(), model.as_str()) {
        ("-", "-") => "-".to_string(),
        ("-", model) => model.to_string(),
        (route, "-") => route.to_string(),
        (route, model) => format!("{route}:{model}"),
    };
    let port_protocol = format!(
        "{}:{}",
        format_v3_console_safe_label(port_label),
        format_v3_console_entry_protocol_label(entry_protocol)
    );
    let project = format_v3_console_project_name(project_path);
    format!(
        "[{}][{}][{}]",
        fit_v3_console_display_width(&port_protocol, V3_CONSOLE_PREFIX_PORT_PROTOCOL_COLUMN_WIDTH),
        fit_v3_console_display_width(&project, V3_CONSOLE_PREFIX_PROJECT_COLUMN_WIDTH),
        fit_v3_console_display_width(&route_model, V3_CONSOLE_PREFIX_ROUTE_MODEL_COLUMN_WIDTH)
    )
}

fn format_v3_console_human_prefix_for_observability(
    port_label: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
    observability: &V3RuntimeObservability,
    route_label: &str,
) -> String {
    format_v3_console_human_prefix(
        port_label,
        entry_protocol,
        project_path,
        &format_v3_console_provider_target_compact(observability),
        route_label,
    )
}

fn format_v3_console_human_prefix_for_port(
    port_label: &str,
    endpoint: &str,
    project_path: Option<&str>,
) -> String {
    format_v3_console_human_prefix(port_label, endpoint, project_path, "-", "-")
}

const V3_CONSOLE_CONTENT_TAG_WIDTH: usize = 24;
const V3_CONSOLE_PREFIX_PORT_PROTOCOL_COLUMN_WIDTH: usize = 24;
const V3_CONSOLE_PREFIX_PROJECT_COLUMN_WIDTH: usize = 20;
const V3_CONSOLE_PREFIX_ROUTE_MODEL_COLUMN_WIDTH: usize = 36;
const V3_CONSOLE_DEBUG_SCOPE_COLUMN_WIDTH: usize = 52;
const V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH: usize = 18;

fn format_v3_console_timed_content(tag: &str, fields: &str) -> String {
    let tag = align_v3_console_display_width(tag, V3_CONSOLE_CONTENT_TAG_WIDTH);
    let timestamp = console_timestamp_hhmmss();
    format!("{tag} {timestamp} {fields}")
}

fn align_v3_console_display_width(value: &str, width: usize) -> String {
    console::align_display_width(value, width)
}

fn fit_v3_console_display_width(value: &str, width: usize) -> String {
    console::fit_display_width(value, width)
}

fn truncate_v3_console_display_width_middle(value: &str, width: usize) -> String {
    console::truncate_display_width_middle(value, width)
}

fn v3_console_display_width(value: &str) -> usize {
    console::display_width(value)
}

fn v3_console_char_display_width(character: char) -> usize {
    console::char_display_width(character)
}

fn format_v3_console_entry_protocol_label(entry_protocol_or_endpoint: &str) -> String {
    let entry = match entry_protocol_or_endpoint.trim() {
        "/v1/responses" => "responses",
        "/v1/messages" => "anthropic",
        "/v1/chat/completions" => "openai_chat",
        "/v1beta/models"
        | "/v1beta/models:generateContent"
        | "/v1beta/models:streamGenerateContent" => "gemini",
        value => value,
    };
    format_v3_console_safe_label(entry)
}

fn format_v3_console_safe_label(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() || character.is_whitespace() {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if normalized.is_empty() {
        "-".to_string()
    } else {
        normalized
    }
}

struct V3ConsoleRouteProjection {
    label: String,
    reason: String,
}

fn resolve_v3_console_route_projection(
    observability: &V3RuntimeObservability,
) -> V3ConsoleRouteProjection {
    if observability.pool_id.as_deref() == Some("dry_run")
        || observability
            .target_path
            .iter()
            .any(|part| part.contains("dry_run"))
    {
        panic!("provider-request dry-run must terminate before V3 console observability emission");
    }
    if let Some(pool) = observability
        .pool_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return V3ConsoleRouteProjection {
            label: pool.to_string(),
            reason: format!("pool:{pool}"),
        };
    }
    if let Some(route) = observability
        .routing_group_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return V3ConsoleRouteProjection {
            label: route.to_string(),
            reason: format!("route:{route}"),
        };
    }
    panic!("v3 console route projection requires pool_id or routing_group_id");
}

fn format_v3_console_provider_target_compact(observability: &V3RuntimeObservability) -> String {
    let (provider_from_key, _, model_from_key) =
        parse_v3_console_provider_key(observability.provider_key.as_deref());
    let provider = observability
        .provider_id
        .as_deref()
        .or(provider_from_key.as_deref())
        .unwrap_or("-");
    let model = observability
        .wire_model
        .as_deref()
        .or(model_from_key.as_deref())
        .or(observability.model_id.as_deref())
        .unwrap_or("-");
    if provider == "-" && model == "-" {
        "-".to_string()
    } else if model == "-" || model.trim().is_empty() {
        provider.to_string()
    } else {
        format!("{provider}.{model}")
    }
}

fn format_v3_console_provider_target(observability: &V3RuntimeObservability) -> String {
    let (provider_from_key, alias_from_key, model_from_key) =
        parse_v3_console_provider_key(observability.provider_key.as_deref());
    let provider = observability
        .provider_id
        .as_deref()
        .or(provider_from_key.as_deref())
        .unwrap_or("-");
    let alias = observability
        .auth_alias
        .as_deref()
        .or(alias_from_key.as_deref())
        .filter(|value| !value.trim().is_empty());
    let model = observability
        .wire_model
        .as_deref()
        .or(model_from_key.as_deref())
        .or(observability.model_id.as_deref());
    let provider_label = match alias {
        Some(alias) => format!("{provider}[{alias}]"),
        None => provider.to_string(),
    };
    match model {
        Some(model) if !model.trim().is_empty() && model != "-" => {
            format!("{provider_label}.{model}")
        }
        _ => provider_label,
    }
}

fn format_v3_console_provider_key_label(provider_key: &str) -> String {
    let (provider_from_key, alias_from_key, model_from_key) =
        parse_v3_console_provider_key(Some(provider_key));
    let provider = provider_from_key.unwrap_or_else(|| provider_key.to_string());
    let provider_label = match alias_from_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(alias) => format!("{provider}[{alias}]"),
        None => provider,
    };
    match model_from_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(model) => format!("{provider_label}.{model}"),
        None => provider_label,
    }
}

fn format_v3_console_single_line_message(message: &str) -> String {
    let normalized = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        "-".to_string()
    } else {
        normalized
    }
}

fn parse_v3_console_provider_key(
    provider_key: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(provider_key) = provider_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (None, None, None);
    };
    let parts = provider_key.split(':').collect::<Vec<_>>();
    match parts.as_slice() {
        [provider, alias, model, ..] => (
            Some((*provider).to_string()),
            Some((*alias).to_string()),
            Some((*model).to_string()),
        ),
        [provider, model] => (
            Some((*provider).to_string()),
            None,
            Some((*model).to_string()),
        ),
        [provider] => (Some((*provider).to_string()), None, None),
        [] => (None, None, None),
    }
}

fn format_v3_usage_request_id(request_id: &str) -> String {
    let normalized = request_id.trim();
    let normalized = if normalized.is_empty() {
        "unknown-request"
    } else {
        normalized
    };
    if let Some(sequence) = parse_v3_direct_sequence(normalized, '-') {
        return sequence;
    }
    if let Some(rest) = normalized.strip_prefix("req_") {
        if let Some(sequence) = parse_v3_direct_sequence(rest, '_') {
            return sequence;
        }
    }
    if let Some(sequence) = parse_v3_trailing_provider_sequence(normalized) {
        return sequence;
    }
    short_v3_request_tail(normalized, 8)
}

fn parse_v3_direct_sequence(value: &str, delimiter: char) -> Option<String> {
    let (left, right) = value.split_once(delimiter)?;
    if !left.is_empty()
        && !right.is_empty()
        && left.chars().all(|character| character.is_ascii_digit())
        && right.chars().all(|character| character.is_ascii_digit())
    {
        Some(format!("{left}-{right}"))
    } else {
        None
    }
}

fn parse_v3_trailing_provider_sequence(value: &str) -> Option<String> {
    let without_suffix = value.split(':').next().unwrap_or(value);
    let mut segments = without_suffix.rsplitn(3, '-');
    let daily = segments.next()?;
    let total = segments.next()?;
    if !daily.is_empty()
        && !total.is_empty()
        && daily.chars().all(|character| character.is_ascii_digit())
        && total.chars().all(|character| character.is_ascii_digit())
    {
        Some(format!("{total}-{daily}"))
    } else {
        None
    }
}

fn short_v3_request_tail(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    chars[chars.len() - max_chars..].iter().collect()
}

fn format_v3_console_project_name(project_path: Option<&str>) -> String {
    let Some(project) = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return "-".to_string();
    };
    let trimmed = project.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return "-".to_string();
    }
    std::path::Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .map(format_v3_console_safe_label)
        .filter(|value| value != "-")
        .unwrap_or_else(|| {
            trimmed
                .rsplit(['/', '\\'])
                .find(|value| !value.trim().is_empty())
                .map(format_v3_console_safe_label)
                .unwrap_or_else(|| "-".to_string())
        })
}

fn format_v3_console_usage_summary(usage: Option<&V3RuntimeUsageSummary>) -> String {
    let Some(usage) = usage else {
        return "usage=unreported".to_string();
    };
    let input_tokens = v3_console_effective_input_tokens(usage);
    let input = input_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let output = usage
        .output_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let total = v3_console_effective_total_tokens(usage)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let cache = match (usage.cached_tokens, input_tokens) {
        (Some(cached), Some(input)) if input > 0 => {
            format!(
                "{cached}/{input}({:.1}%)",
                (cached as f64 / input as f64) * 100.0
            )
        }
        (Some(cached), _) => cached.to_string(),
        (None, _) => "0".to_string(),
    };
    format!("usage_in={input} usage_out={output} usage_cache={cache} usage_total={total}")
}

fn format_v3_console_human_usage_summary(usage: Option<&V3RuntimeUsageSummary>) -> Option<String> {
    let usage = usage?;
    let mut fields = Vec::new();
    let input_tokens = v3_console_effective_input_tokens(usage);
    if let Some(input) = input_tokens {
        fields.push(format!("usage_in={input}"));
    }
    if let Some(output) = usage.output_tokens {
        fields.push(format!("usage_out={output}"));
    }
    if let Some(cached) = usage.cached_tokens {
        let cache = match input_tokens {
            Some(input) if input > 0 => {
                format!(
                    "{cached}/{input}({:.1}%)",
                    (cached as f64 / input as f64) * 100.0
                )
            }
            _ => cached.to_string(),
        };
        fields.push(format!("usage_cache={cache}"));
    }
    if let Some(total) = v3_console_effective_total_tokens(usage) {
        fields.push(format!("usage_total={total}"));
    }
    (!fields.is_empty()).then(|| fields.join(" "))
}

fn v3_console_effective_input_tokens(usage: &V3RuntimeUsageSummary) -> Option<u64> {
    match (usage.input_tokens, usage.cached_tokens) {
        // Anthropic reports an uncached increment plus a separate cache-read count.
        (Some(input), Some(cached)) if cached > input => input.checked_add(cached),
        (input, _) => input,
    }
}

fn v3_console_effective_total_tokens(usage: &V3RuntimeUsageSummary) -> Option<u64> {
    match (usage.total_tokens, usage.input_tokens, usage.cached_tokens) {
        (Some(total), Some(input), Some(cached)) if cached > input => total.checked_add(cached),
        (total, _, _) => total,
    }
}

fn read_v3_console_response_status(value: &Value) -> Option<String> {
    read_v3_console_string_path(value, &["status"])
        .or_else(|| read_v3_console_string_path(value, &["response", "status"]))
        .or_else(|| read_v3_console_string_path(value, &["message", "status"]))
}

fn read_v3_console_finish_reason(value: &Value) -> Option<String> {
    read_v3_console_string_path(value, &["finish_reason"])
        .or_else(|| read_v3_console_string_path(value, &["finishReason"]))
        .or_else(|| read_v3_console_string_path(value, &["stop_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["stopReason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "finish_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "finishReason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "stop_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["response", "stopReason"]))
        .or_else(|| read_v3_console_string_path(value, &["choices", "0", "finish_reason"]))
        .or_else(|| read_v3_console_string_path(value, &["candidates", "0", "finishReason"]))
}

fn infer_v3_console_finish_reason_from_response_status(
    response_status: Option<&str>,
) -> Option<String> {
    match response_status.map(str::trim) {
        Some(status) if status.eq_ignore_ascii_case("completed") => Some("stop".to_string()),
        Some(status) if status.eq_ignore_ascii_case("done") => Some("stop".to_string()),
        Some(status) if status.eq_ignore_ascii_case("requires_action") => {
            Some("tool_calls".to_string())
        }
        _ => None,
    }
}

fn read_v3_console_string_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        if let Ok(index) = segment.parse::<usize>() {
            current = current.get(index)?;
        } else {
            current = current.get(*segment)?;
        }
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_v3_console_usage_summary(value: &Value) -> Option<V3RuntimeUsageSummary> {
    let usage = value.get("usage")?;
    let summary = V3RuntimeUsageSummary {
        input_tokens: read_v3_console_usage_u64(usage, &["input_tokens"])
            .or_else(|| read_v3_console_usage_u64(usage, &["prompt_tokens"])),
        output_tokens: read_v3_console_usage_u64(usage, &["output_tokens"])
            .or_else(|| read_v3_console_usage_u64(usage, &["completion_tokens"])),
        total_tokens: read_v3_console_usage_u64(usage, &["total_tokens"]),
        cached_tokens: read_v3_console_usage_u64(usage, &["input_tokens_details", "cached_tokens"])
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["input_tokens_details", "cached_read_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["input_tokens_details", "cache_read_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["prompt_tokens_details", "cached_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["prompt_tokens_details", "cached_read_tokens"])
            })
            .or_else(|| {
                read_v3_console_usage_u64(usage, &["prompt_tokens_details", "cache_read_tokens"])
            })
            .or_else(|| read_v3_console_usage_u64(usage, &["cache_read_input_tokens"])),
    };
    if summary.input_tokens.is_some()
        || summary.output_tokens.is_some()
        || summary.total_tokens.is_some()
        || summary.cached_tokens.is_some()
    {
        Some(summary)
    } else {
        None
    }
}

fn read_v3_console_usage_u64(value: &Value, path: &[&str]) -> Option<u64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_u64().or_else(|| {
        current
            .as_i64()
            .and_then(|number| u64::try_from(number).ok())
    })
}

fn emit_v3_frame_error_console_line(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    frame: &V3Server16HttpFrame,
    project_path: Option<&str>,
) {
    if frame.error_chain.is_empty() && frame.status < 400 {
        return;
    }
    emit_v3_error_console_line(
        server,
        endpoint,
        request_id,
        frame.status,
        &frame.error_chain,
        v3_server_frame_error_body_for_console(frame),
        project_path,
    );
}

fn emit_v3_frame_error_console_line_for_state(
    state: &V3ListenerState,
    endpoint: &str,
    request_id: &str,
    frame: &V3Server16HttpFrame,
    project_path: Option<&str>,
) {
    if frame.error_chain.is_empty() && frame.status < 400 {
        return;
    }
    emit_v3_error_console_line_for_state(
        state,
        endpoint,
        request_id,
        frame.status,
        &frame.error_chain,
        v3_server_frame_error_body_for_console(frame),
        project_path,
    );
}

fn emit_v3_frame_error_console_line_for_context(
    context: &V3ConsoleEmissionContext,
    frame: &V3Server16HttpFrame,
    observability: &V3RuntimeObservability,
) {
    if frame.error_chain.is_empty() && frame.status < 400 {
        return;
    }
    emit_v3_error_console_line_for_context(
        context,
        observability,
        frame.status,
        &frame.error_chain,
        v3_server_frame_error_body_for_console(frame),
    );
}

fn v3_server_frame_error_body_for_console(frame: &V3Server16HttpFrame) -> Option<&Value> {
    frame.error_body.as_ref().or_else(|| match &frame.body {
        V3Server16Body::Json(value) => Some(value),
        V3Server16Body::Bytes(_) | V3Server16Body::Sse(_) => None,
    })
}

fn emit_v3_error_console_line_for_context(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) {
    let identity = context.identity.clone();
    let route = resolve_v3_console_route_projection(observability);
    let content = format_v3_error_console_content(
        &context.endpoint,
        &context.request_identity.request_id,
        status,
        error_chain,
        body,
    );
    let content_str = content.as_str();
    let prefix = format_v3_console_human_prefix_for_observability(
        &context.state.server.port.to_string(),
        &context.entry_protocol,
        identity.project_path.as_deref(),
        observability,
        &route.label,
    );
    let colorized =
        colorize_v3_error_console_line(&prefix, content_str, content_str, &identity.session_id);
    append_v3_human_console_line(&context.state, &colorized);
    eprintln!("{colorized}");
}

fn emit_v3_error_console_line(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
    project_path: Option<&str>,
) {
    emit_v3_error_console_line_with_port(
        &server.port.to_string(),
        endpoint,
        request_id,
        status,
        error_chain,
        body,
        project_path,
    );
}

fn emit_v3_error_console_line_with_port(
    port_label: &str,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
    project_path: Option<&str>,
) {
    let (headline, debug) =
        format_v3_error_console_headline_and_debug(endpoint, request_id, status, error_chain, body);
    let prefix = format_v3_console_human_prefix_for_port(port_label, endpoint, project_path);
    eprintln!(
        "{}",
        colorize_v3_error_console_line(&prefix, &headline, &debug, "-")
    );
}

fn emit_v3_error_console_line_for_state(
    state: &V3ListenerState,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
    project_path: Option<&str>,
) {
    let (headline, debug) =
        format_v3_error_console_headline_and_debug(endpoint, request_id, status, error_chain, body);
    let prefix = format_v3_console_human_prefix_for_port(
        &state.server.port.to_string(),
        endpoint,
        project_path,
    );
    let colorized = colorize_v3_error_console_line(&prefix, &headline, &debug, "-");
    append_v3_human_console_line(state, &colorized);
    eprintln!("{colorized}");
}

fn format_v3_error_console_headline_and_debug(
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) -> (String, String) {
    let content = format_v3_error_console_content(endpoint, request_id, status, error_chain, body);
    (content.clone(), content)
}

fn format_v3_error_console_content(
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) -> String {
    let error_code = body
        .and_then(|value| value.pointer("/error/code").and_then(Value::as_str))
        .or_else(|| body.and_then(|value| value.pointer("/error/type").and_then(Value::as_str)))
        .unwrap_or("v3_error");
    let message = body
        .and_then(|value| value.pointer("/error/message").and_then(Value::as_str))
        .unwrap_or("V3 request failed");
    let error_node = error_chain
        .last()
        .copied()
        .unwrap_or("V3Error06ClientProjected");
    let error_number = compact_v3_error_number(error_chain);
    format_v3_console_timed_content(
        &format!("❌ [{endpoint}]"),
        &format!(
            "req={} event=failed status={} error={} subcode={} node={} message={}",
            request_id,
            status,
            error_number,
            error_code,
            error_node,
            format_v3_console_single_line_message(message)
        ),
    )
}

fn compact_v3_error_number(error_chain: &[&'static str]) -> String {
    let node = error_chain
        .last()
        .copied()
        .unwrap_or("V3Error06ClientProjected");
    let digits = node
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        "V3E00".to_string()
    } else {
        format!("V3E{digits}")
    }
}

fn emit_v3_startup_console_line(listeners: &[V3ListenerHandle]) {
    println!("{}", format_v3_startup_console_block(listeners));
    let _ = io::stdout().flush();
}

fn format_v3_startup_console_block(listeners: &[V3ListenerHandle]) -> String {
    let addresses = listeners
        .iter()
        .map(|listener| listener.addr.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let executable = std::env::current_exe().ok();
    let binary = executable
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let version = executable
        .as_deref()
        .and_then(resolve_routecodex_package_version_from_executable)
        .unwrap_or_else(|| "unknown".to_string());
    let prefix = format_v3_console_human_prefix("server", "startup", None, "-", "-");
    let headline = format_v3_console_timed_content("✅ [RouteCodexV3]", "Server started");
    let debug = format!(
        "event=started version={} crate={} binary={} addresses={addresses}",
        version,
        env!("CARGO_PKG_VERSION"),
        binary,
    );
    colorize_v3_request_console_line(&prefix, &headline, &debug, None, "-")
}

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_REQUEST_CYAN: &str = "\x1b[36m";
const ANSI_DEBUG_DIM: &str = "\x1b[2;90m";
const ANSI_ERROR_RED: &str = "\x1b[31m";
const ANSI_STOPLESS_ORANGE: &str = "\x1b[38;5;208m";

#[derive(Clone, Copy)]
struct V3ConsoleLayeredBlock<'a> {
    human_prefix: &'a str,
    headline: &'a str,
    debug: &'a str,
    session_id: &'a str,
}

impl<'a> V3ConsoleLayeredBlock<'a> {
    fn new(human_prefix: &'a str, headline: &'a str, debug: &'a str, session_id: &'a str) -> Self {
        assert!(
            !headline.is_empty(),
            "v3 console layered headline must be non-empty"
        );
        assert!(
            !debug.is_empty(),
            "v3 console layered debug must be non-empty"
        );
        Self {
            human_prefix,
            headline,
            debug,
            session_id,
        }
    }

    fn diagnostic(self) -> String {
        let safe_session = format_v3_console_safe_label(self.session_id);
        let session = if safe_session.is_empty() {
            "-"
        } else {
            &safe_session
        };
        let session_width =
            V3_CONSOLE_DEBUG_SCOPE_COLUMN_WIDTH - v3_console_display_width("[sessionID:]");
        let display_session = truncate_v3_console_display_width_middle(session, session_width);
        let scope = format!("[sessionID:{display_session}]");
        let diagnostic = format!(
            "{} {}",
            align_v3_console_display_width(&scope, V3_CONSOLE_DEBUG_SCOPE_COLUMN_WIDTH),
            self.debug
        );
        if display_session == session {
            diagnostic
        } else {
            format!("{diagnostic} sessionIDFull={session}")
        }
    }
}

fn is_v3_console_color_enabled() -> bool {
    let routecodex_force = std::env::var("ROUTECODEX_FORCE_LOG_COLOR")
        .ok()
        .or_else(|| std::env::var("RCC_FORCE_LOG_COLOR").ok())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(routecodex_force.as_str(), "1" | "true" | "yes" | "on") {
        return true;
    }
    if matches!(routecodex_force.as_str(), "0" | "false" | "no" | "off") {
        return false;
    }
    let force_color = std::env::var("FORCE_COLOR").unwrap_or_default();
    if force_color.trim() == "0" {
        return false;
    }
    true
}

fn colorize_v3_request_console_line(
    human_prefix: &str,
    headline: &str,
    debug: &str,
    color_key: Option<&str>,
    session_id: &str,
) -> String {
    let block = V3ConsoleLayeredBlock::new(human_prefix, headline, debug, session_id);
    if !is_v3_console_color_enabled() {
        return format_v3_console_layered_block_plain(block);
    }
    let color = color_key
        .and_then(resolve_v3_session_color)
        .unwrap_or_else(|| ANSI_REQUEST_CYAN.to_string());
    colorize_v3_layered_console_line(block, &color, ANSI_DEBUG_DIM)
}

fn colorize_v3_error_console_line(
    human_prefix: &str,
    headline: &str,
    debug: &str,
    session_id: &str,
) -> String {
    let block = V3ConsoleLayeredBlock::new(human_prefix, headline, debug, session_id);
    if !is_v3_console_color_enabled() {
        return format_v3_console_layered_block_plain(block);
    }
    colorize_v3_layered_console_line(block, ANSI_ERROR_RED, ANSI_DEBUG_DIM)
}

fn colorize_v3_stopless_console_line(
    human_prefix: &str,
    headline: &str,
    debug: &str,
    session_id: &str,
) -> String {
    let block = V3ConsoleLayeredBlock::new(human_prefix, headline, debug, session_id);
    if !is_v3_console_color_enabled() {
        return format_v3_console_layered_block_plain(block);
    }
    colorize_v3_layered_console_line(block, ANSI_STOPLESS_ORANGE, ANSI_DEBUG_DIM)
}

fn colorize_v3_layered_console_line(
    block: V3ConsoleLayeredBlock<'_>,
    headline_color: &str,
    debug_color: &str,
) -> String {
    let human_line = if block.human_prefix.is_empty() {
        block.headline.to_string()
    } else {
        format!("{} {}", block.human_prefix, block.headline)
    };
    let diagnostic = block.diagnostic();
    format!("{headline_color}{human_line}{ANSI_RESET}\n\n{debug_color}  {diagnostic}{ANSI_RESET}")
}

fn format_v3_console_layered_block_plain(block: V3ConsoleLayeredBlock<'_>) -> String {
    let head = if block.human_prefix.is_empty() {
        block.headline.to_string()
    } else {
        format!("{} {}", block.human_prefix, block.headline)
    };
    format!("{head}\n\n  {}", block.diagnostic())
}

fn resolve_v3_log_session_color_key(
    headers: &HeaderMap,
    payload: &Value,
    request_id: &str,
) -> Option<String> {
    let turn_metadata = parse_codex_turn_metadata(headers).ok().flatten();
    let explicit_session = first_header_text(
        headers,
        &[
            "session-id",
            "session_id",
            "x-session-id",
            "x-routecodex-session-id",
            "x-rcc-session-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_SESSION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_SESSION_PATHS));
    if explicit_session.is_some() {
        return explicit_session;
    }
    let explicit_conversation = first_header_text(
        headers,
        &[
            "thread-id",
            "thread_id",
            "conversation-id",
            "conversation_id",
            "x-conversation-id",
            "x-routecodex-conversation-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_CONVERSATION_PATHS));
    if explicit_conversation.is_some() {
        return explicit_conversation;
    }
    let client_type = infer_v3_log_client_type(headers);
    let tmux_scope = first_header_text(
        headers,
        &[
            "x-routecodex-client-tmux-session-id",
            "x-rcc-client-tmux-session-id",
            "x-routecodex-tmux-session-id",
            "x-rcc-tmux-session-id",
            "x-tmux-session-id",
        ],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_TMUX_PATHS));
    let workdir = first_header_text(
        headers,
        &["x-routecodex-workdir", "x-rcc-workdir", "x-workdir"],
    )
    .ok()
    .flatten()
    .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_WORKDIR_PATHS))
    .or_else(|| read_first_scope_value(Some(payload), BODY_WORKDIR_PATHS))
    .or_else(|| {
        resolve_v3_console_project_path_with_metadata(headers, payload, turn_metadata.as_ref())
    });
    let mut parts = Vec::new();
    for value in [client_type, tmux_scope, workdir] {
        if let Some(part) = value.and_then(|candidate| normalize_v3_log_session_part(&candidate)) {
            parts.push(part);
        }
    }
    if parts.is_empty() {
        normalize_v3_log_session_part(request_id).map(|part| format!("rcc-session:request:{part}"))
    } else {
        Some(format!("rcc-session:{}", parts.join(":")))
    }
}

fn infer_v3_log_client_type(headers: &HeaderMap) -> Option<String> {
    let user_agent = header_text(headers, "user-agent")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let originator = header_text(headers, "originator")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if user_agent.contains("codex") || originator.contains("codex") {
        Some("codex".to_string())
    } else if user_agent.contains("claude") || originator.contains("claude") {
        Some("claude".to_string())
    } else {
        None
    }
}

fn normalize_v3_log_session_part(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn resolve_v3_session_color(session_id: &str) -> Option<String> {
    if session_id.trim().is_empty() {
        return None;
    }
    let hash = hash_v3_session_log_color_token(session_id.trim());
    let mut hue = (hash % 3600) as f64 / 10.0;
    if !(18.0..342.0).contains(&hue) {
        hue = (hue + 47.0) % 360.0;
    }
    let saturation = 0.62 + (((hash >> 12) & 0xff) as f64 / 255.0) * 0.24;
    let lightness = 0.50 + (((hash >> 20) & 0xff) as f64 / 255.0) * 0.16;
    let (red, green, blue) = hsl_to_rgb(hue, saturation, lightness);
    Some(format!("\x1b[38;2;{};{};{}m", red, green, blue))
}

fn hash_v3_session_log_color_token(value: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x7feb352d);
    hash ^= hash >> 15;
    hash = hash.wrapping_mul(0x846ca68b);
    hash ^= hash >> 16;
    hash
}

fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> (u8, u8, u8) {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let hue_prime = hue / 60.0;
    let x = chroma * (1.0 - ((hue_prime % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if hue_prime < 1.0 {
        (chroma, x, 0.0)
    } else if hue_prime < 2.0 {
        (x, chroma, 0.0)
    } else if hue_prime < 3.0 {
        (0.0, chroma, x)
    } else if hue_prime < 4.0 {
        (0.0, x, chroma)
    } else if hue_prime < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    let m = lightness - chroma / 2.0;
    let to_channel = |value: f64| -> u8 { ((value + m).clamp(0.0, 1.0) * 255.0).round() as u8 };
    (to_channel(r1), to_channel(g1), to_channel(b1))
}

fn console_timestamp_hhmmss() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as libc::time_t)
        .unwrap_or(0);
    console_timestamp_hhmmss_for_epoch_seconds(seconds).unwrap_or_else(|_| {
        let seconds = u64::try_from(seconds).unwrap_or(0) % 86_400;
        let hour = seconds / 3_600;
        let minute = (seconds % 3_600) / 60;
        let second = seconds % 60;
        format!("{hour:02}:{minute:02}:{second:02}")
    })
}

fn console_timestamp_hhmmss_for_epoch_seconds(seconds: libc::time_t) -> Result<String, String> {
    let local = format_v3_tm(seconds, true)?;
    Ok(format!(
        "{:02}:{:02}:{:02}",
        local.hour, local.minute, local.second
    ))
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

fn build_v3_provider_failure_session_scope_for_request(
    server: &V3ServerManifest,
    headers: &HeaderMap,
) -> Option<V3ProviderFailureSessionScope> {
    provider_failure_session_id_from_request_headers(headers)
        .ok()
        .flatten()
        .and_then(|session_id| {
            V3ProviderFailureSessionScope::new(&server.id, &server.routing_group, &session_id).ok()
        })
}

/// Get the provider-failure control scope without changing the client request.
///
/// A client session header is optional request data. It is useful when present,
/// but it is not a prerequisite for an ordinary request and must never be
/// synthesized into headers or payload. Requests without one use their already
/// allocated internal request id as a request-local control-scope key.
fn get_failure_session_scope(
    server: &V3ServerManifest,
    headers: &HeaderMap,
    _entry_protocol: &str,
    request_id: &str,
) -> Result<V3ProviderFailureSessionScope, String> {
    if let Some(scope) = build_v3_provider_failure_session_scope_for_request(server, headers) {
        return Ok(scope);
    }
    V3ProviderFailureSessionScope::new(
        &server.id,
        &server.routing_group,
        format!("request-local-{request_id}"),
    )
}

fn provider_failure_session_id_from_request_headers(
    headers: &HeaderMap,
) -> Result<Option<String>, String> {
    first_header_text(
        headers,
        &[
            "session-id",
            "session_id",
            "x-session-id",
            "x-rcc-session-id",
        ],
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3ResponsesContinuationEntryFacts {
    previous_response_id: Option<String>,
    has_function_call_output: bool,
    has_unpaired_function_call_output: bool,
}

impl V3ResponsesContinuationEntryFacts {
    fn project(payload: &Value) -> Self {
        Self {
            previous_response_id: responses_payload_previous_response_id(payload),
            has_function_call_output: payload_input_has_function_call_output(payload.get("input")),
            has_unpaired_function_call_output: payload_input_has_unpaired_function_call_output(
                payload.get("input"),
            ),
        }
    }
}

fn responses_entry_facts_allow_fresh_protocol_plan(
    entry_facts: &V3ResponsesContinuationEntryFacts,
) -> bool {
    entry_facts.previous_response_id.is_none() && !entry_facts.has_unpaired_function_call_output
}

fn responses_effective_execution_mode_for_entry_facts(
    configured_mode: V3EntryProtocolExecutionMode,
    entry_facts: &V3ResponsesContinuationEntryFacts,
) -> V3EntryProtocolExecutionMode {
    match configured_mode {
        V3EntryProtocolExecutionMode::PendingNotImplemented => configured_mode,
        V3EntryProtocolExecutionMode::Direct | V3EntryProtocolExecutionMode::Relay
            if responses_entry_facts_allow_fresh_protocol_plan(entry_facts) =>
        {
            // Fresh implemented Responses bindings enter Relay as the orchestration
            // shell, then choose Direct or Relay after ReqChatProcess governance.
            V3EntryProtocolExecutionMode::Relay
        }
        V3EntryProtocolExecutionMode::Direct | V3EntryProtocolExecutionMode::Relay => {
            configured_mode
        }
    }
}

fn responses_payload_previous_response_id(payload: &Value) -> Option<String> {
    payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn build_responses_direct_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    entry_facts: &V3ResponsesContinuationEntryFacts,
) -> Result<V3ResponsesDirectContinuationScope, String> {
    let (session_id, conversation_id) = request_local_continuation_scope(
        headers,
        entry_facts.previous_response_id.is_some() || entry_facts.has_function_call_output,
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

fn build_responses_relay_local_continuation_scope(
    headers: &HeaderMap,
    request_id: &str,
    server: &V3ServerManifest,
    endpoint: &str,
    entry_facts: &V3ResponsesContinuationEntryFacts,
) -> Result<V3ResponsesRelayLocalContinuationScope, String> {
    let (session_id, conversation_id) = request_local_continuation_scope(
        headers,
        entry_facts.previous_response_id.is_some() || entry_facts.has_unpaired_function_call_output,
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
    entry_facts: &V3ResponsesContinuationEntryFacts,
) -> Result<Option<V3ResponsesPreviousResponseOwnerResolutionContext>, String> {
    if entry_facts.previous_response_id.is_none() {
        return Ok(None);
    }
    let direct_scope = build_responses_direct_continuation_scope(
        headers,
        request_id,
        server,
        endpoint,
        entry_facts,
    )?;
    let relay_scope = build_responses_relay_local_continuation_scope(
        headers,
        request_id,
        server,
        endpoint,
        entry_facts,
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

fn request_local_continuation_scope(
    headers: &HeaderMap,
    requires_client_scope: bool,
    request_id: &str,
) -> Result<(String, String), String> {
    let (session_id, conversation_id) = responses_control_scope_headers(headers)?;
    match (session_id, conversation_id) {
        (Some(session_id), Some(conversation_id)) => Ok((session_id, conversation_id)),
        (None, None) if !requires_client_scope => {
            let request_scope = format!("request:{request_id}");
            Ok((request_scope.clone(), request_scope))
        }
        _ => Err(
            "Responses continuation requires typed session and conversation control headers; request payload and client metadata cannot construct continuation control identity"
                .to_string(),
        ),
    }
}

fn responses_control_scope_headers(
    headers: &HeaderMap,
) -> Result<(Option<String>, Option<String>), String> {
    let direct_session_id = first_header_text(
        headers,
        &[
            "session-id",
            "session_id",
            "x-session-id",
            "x-rcc-session-id",
        ],
    )?;
    let direct_conversation_id = first_header_text(
        headers,
        &[
            "thread-id",
            "thread_id",
            "conversation-id",
            "conversation_id",
            "x-conversation-id",
        ],
    )?;
    if direct_session_id.is_some() && direct_conversation_id.is_some() {
        return Ok((direct_session_id, direct_conversation_id));
    }
    let turn_metadata = parse_codex_turn_metadata(headers)?;
    let session_id = direct_session_id
        .or_else(|| read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_SESSION_PATHS));
    let conversation_id = direct_conversation_id.or_else(|| {
        read_first_scope_value(turn_metadata.as_ref(), TURN_METADATA_CONVERSATION_PATHS)
    });
    Ok((session_id, conversation_id))
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
    &["session_id"],
    &["sessionId"],
    &["sessionID"],
    &["session-id"],
    &["client_metadata", "sessionID"],
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
    &["thread_id"],
    &["threadId"],
    &["threadID"],
    &["thread-id"],
    &["conversation_id"],
    &["conversationId"],
    &["conversationID"],
    &["conversation-id"],
    &["client_metadata", "threadID"],
    &["client_metadata", "thread_id"],
    &["client_metadata", "threadId"],
    &["client_metadata", "thread-id"],
    &["client_metadata", "conversation_id"],
    &["client_metadata", "conversationId"],
    &["client_metadata", "conversationID"],
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

fn collect_anthropic_relay_client_headers(
    headers: &HeaderMap,
) -> Result<Vec<V3AnthropicRelayClientHeader>, String> {
    let mut provider_headers = Vec::new();
    for (name, value) in headers {
        let name = name.as_str();
        if !V3AnthropicRelayClientHeader::is_provider_protocol_header_name(name) {
            continue;
        }
        let value = value
            .to_str()
            .map(str::trim)
            .map_err(|error| format!("{name} is not UTF-8: {error}"))?;
        if value.is_empty() {
            continue;
        }
        if let Some(header) = V3AnthropicRelayClientHeader::provider_protocol(name, value) {
            provider_headers.push(header);
        }
    }
    Ok(provider_headers)
}

pub async fn execute_v3_anthropic_messages_request(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> Result<V3AnthropicRelayRuntimeOutput, routecodex_v3_runtime::V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_anthropic_messages_request_with_client_headers(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    client_headers: Vec<V3AnthropicRelayClientHeader>,
) -> Result<V3AnthropicRelayRuntimeOutput, routecodex_v3_runtime::V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_default_transport_and_client_headers(
        manifest,
        input,
        client_headers,
    )
    .await
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

fn responses_relay_output_response(
    output: V3ResponsesRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
    keepalive_interval: Duration,
) -> Response<Body> {
    let successful_sse = output.error_chain.is_none() && output.status < 400;
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
            successful_sse.then_some(keepalive_interval),
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
                V3SseConsoleStreamTerminal::Completed => finalizer.complete_relay_sse(),
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
                this.closeout.take();
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
                this.closeout.take();
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

/// OpenAI Chat SSE 请求（Relay）：客户端 SSE 连接由 proxy（routecodex）独立管理，
/// 与 provider 完全解耦——不提前回任何状态码、不注入 keepalive/其他污染语义的帧，
/// 连接在完整链（VR 命中 → Relay → Provider 请求 → provider 响应完整入站 + resp
/// 转换）执行期间由 hyper 保持；provider 出错由内部 provider-failure 策略自动
/// 切换（reselect），切完继续等最终响应，客户端全程无感知；最终以 200 + 完整
/// SSE 响应体返回（Body::from 完整 bytes，规避 Body::from_stream 在 axum/hyper
/// 写回前的连接关闭竞态——h2_p6）。
async fn v3_openai_chat_relay_sse_accept_response(
    state: &Arc<V3ListenerState>,
    payload: Value,
    request_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
) -> Response<Body> {
    use futures_util::StreamExt;
    let manifest = state.manifest.clone();
    let provider_health = state.provider_health.runtime_health();
    let input = V3OpenAiChatRelayRuntimeInput {
        server_id: state.server.id.clone(),
        failure_session_scope,
        request_id: request_id.clone(),
        payload,
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
    let keepalive_ms = state.server.http_sse_keepalive_ms.max(1000);
    tokio::spawn(async move {
        // 标准 SSE 心跳帧（注释行，连接保持、不塞任何语义）；完整链执行期间定期
        // 发送，客户端不会因 provider 慢/挂起判定连接断。
        let heartbeat: Vec<u8> = b": keepalive\n\n".to_vec();
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(keepalive_ms));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let run = async {
            execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
                &manifest,
                input,
                provider_health,
            )
            .await
        };
        tokio::pin!(run);
        loop {
            tokio::select! {
                biased;
                result = &mut run => {
                    // 完整链（VR 命中 → Relay → Provider → resp 转换）完成；空响应
                    // 自动重试 3 次/错误链/reselect/502 投影已在 relay runtime 内完成
                    // （错误链：handle_provider_failure → 3 次拉黑 15 分钟 → 切 provider），
                    // server 只负责把转换结果喂给客户端（连接与心跳由 server 管理）。
                    match result {
                        Ok(output) => match output.client_body {
                            V3OpenAiChatRelayClientBody::Sse(stream) => {
                                // runtime 已收集完整流（iter），直接透传数据帧。
                                let mut stream = stream;
                                while let Some(chunk) = stream.next().await {
                                    let chunk = chunk.map_err(std::io::Error::other);
                                    if tx.send(chunk).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            V3OpenAiChatRelayClientBody::Json(json) => {
                                // provider 以 JSON 完成（非 SSE）：包装为 SSE data 帧。
                                let bytes = serde_json::to_vec(&json).unwrap_or_default();
                                let mut frame = Vec::with_capacity(bytes.len() + 8);
                                frame.extend_from_slice(b"data: ");
                                frame.extend_from_slice(&bytes);
                                frame.extend_from_slice(b"\n\n");
                                let _ = tx.send(Ok(frame)).await;
                            }
                        },
                        Err(error) => {
                            // 骨架级错误（非 provider 失败）：投影 SSE error 帧。
                            let error_frame = serde_json::json!({
                                "error": {
                                    "message": format!("relay runtime error: {error}"),
                                    "type": "relay_runtime_error",
                                    "code": "relay_runtime_error",
                                }
                            });
                            let bytes = serde_json::to_vec(&error_frame).unwrap_or_default();
                            let mut frame = Vec::with_capacity(bytes.len() + 8);
                            frame.extend_from_slice(b"data: ");
                            frame.extend_from_slice(&bytes);
                            frame.extend_from_slice(b"\n\n");
                            let _ = tx.send(Ok(frame)).await;
                        }
                    }
                    return;
                }
                _ = interval.tick() => {
                    if tx.send(Ok(heartbeat.clone())).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    // 客户端 SSE 连接由 proxy（routecodex）独立管理：立即回 200 + text/event-stream，
    // 后台任务注入标准 SSE 心跳（`: keepalive` 注释帧，连接保持、不塞语义）并喂入
    // 完整链转换结果——客户端不会因 provider 慢/错误判定连接断或收到半截响应
    // （错误走内部错误链 + 切 provider）。
    let client_stream: V3IoSseStream = Box::pin(futures_util::stream::unfold(
        rx,
        |mut rx| async move { rx.recv().await.map(|item| (item, rx)) },
    ));
    let body = v3_io_sse_body(client_stream, None);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(body)
        .expect("SSE accept response")
}

/// OpenAI Chat 入口动态绑定：入口协议与出口 provider 同协议（chat wire）
/// 走统一 direct 骨架（`execute_v3_direct_runtime_kernel_core` + ChatCodec）；
/// 异协议由骨架返回 RelayHandoff，转 chat relay runtime（入口已归一化到 chat）。
async fn execute_v3_openai_chat_direct_server_outcome(
    state: &Arc<V3ListenerState>,
    method: String,
    path: String,
    request_id: String,
    execution_id: String,
    payload: Value,
    provider_failure_session_scope: V3ProviderFailureSessionScope,
    request_headers: &HeaderMap,
    request_identity: &V3AllocatedRequestIdentity,
    started_at: Instant,
    _project_path: Option<&str>,
) -> Response<Body> {
    let console_payload = payload.clone();
    let console_context = build_v3_console_emission_context(
        state,
        "openai_chat",
        &path,
        request_identity,
        request_headers,
        &console_payload,
    );
    let provider_failure_event_sink = build_v3_provider_failure_event_sink(&console_context);
    let route_selection_event_sink = build_v3_route_selection_event_sink(&console_context);
    let raw = build_v3_server_03_http_request_raw(
        state.server.id.clone(),
        provider_failure_session_scope.clone(),
        request_id.clone(),
        execution_id,
        method,
        path.clone(),
        payload.clone(),
    );
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    };
    let output = routecodex_v3_runtime::execute_v3_direct_runtime_kernel_core::<
        V3ChatDirectCodec,
        _,
    >(
        (),
        &state.manifest,
        raw,
        routecodex_v3_runtime::default_responses_transport(),
        state.provider_health.runtime_health(),
        now_epoch_ms,
        Some(&provider_failure_event_sink),
        Some(&route_selection_event_sink),
    )
    .await;
    if let Some(handoff) = output.protocol_relay_handoff {
        let relay_trace = handoff.node_trace;
        // SSE 请求：立即 201 + keepalive 维持连接，后台执行完整 relay 链
        // （客户端连接与 provider 解耦，provider 挂起/慢不影响 client 连接）。
        if payload.get("stream").and_then(Value::as_bool) == Some(true) {
            return v3_openai_chat_relay_sse_accept_response(
                state,
                payload.clone(),
                request_id.clone(),
                provider_failure_session_scope.clone(),
            )
            .await;
        }
        let relay_result = execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
            &state.manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: state.server.id.clone(),
                failure_session_scope: provider_failure_session_scope,
                request_id: request_id.clone(),
                payload,
            },
            state.provider_health.runtime_health(),
        )
        .await;
        let mut relay_output = match relay_result {
            Ok(output) => output,
            Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
        };
        let mut trace = relay_trace;
        trace.extend(relay_output.node_trace);
        relay_output.node_trace = trace;
        if let Some(response) = capture_v3_openai_chat_relay_response(
            state,
            &V3DebugTraceScope {
                server_id: state.server.id.clone(),
                request_id: request_id.clone(),
                execution_id: String::new(),
            },
            "openai_chat",
            &path,
            &request_id,
            &console_payload,
            &mut relay_output,
        ) {
            return response;
        }
        return openai_chat_relay_output_response(relay_output);
    }
    let mut frame = build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    );
    frame.observability = output.observability;
    frame.stream_observation = output.stream_observation;
    let has_provider_failure = frame.observability.as_ref().is_some_and(|observability| {
        !observability.provider_failure_events.is_empty()
    });
    if frame.status >= 400 || has_provider_failure {
        let _ = persist_v3_error_evidence_payload(
            state,
            "openai_chat",
            &path,
            &request_id,
            "request.json",
            &state
                .debug
                .redact_payload_for_side_channel(console_payload.clone()),
        );
        let _ = persist_v3_error_evidence_payload(
            state,
            "openai_chat",
            &path,
            &request_id,
            "error.json",
            &json!({
                "object": "routecodex.v3.error_evidence",
                "stage": "error",
                "status": frame.status,
                "request_id": request_id,
                "endpoint": path,
                "node_trace": frame.node_trace.clone(),
                "error_chain": frame.error_chain.clone(),
                "observability": frame.observability.as_ref().map(project_v3_runtime_observability_debug),
            }),
        );
    }
    if let Some(response) = capture_v3_responses_direct_response(
        state,
        "openai_chat",
        &path,
        &request_id,
        &mut frame,
    ) {
        return response;
    }
    let stream_console_finalizer =
        emit_v3_direct_frame_console_lines(&console_context, &frame, started_at);
    responses_direct_output_response_with_console(
        frame,
        stream_console_finalizer,
        Duration::from_millis(state.server.http_sse_keepalive_ms),
    )
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
        Ok(status) => {
            let mut status = serde_json::to_value(status)
                .expect("V3DebugStatusProjection must remain serializable");
            if let Some(object) = status.as_object_mut() {
                object.insert(
                    "codex_samples_enabled".to_string(),
                    Value::Bool(state.codex_sample_store.is_enabled()),
                );
                object.insert(
                    "direct_snapshots_enabled".to_string(),
                    Value::Bool(
                        state.codex_sample_store.is_enabled()
                            && state.manifest.debug.snapshot_direct,
                    ),
                );
            }
            json_response(200, json!({ "debug": status }))
        }
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
                .body(v3_client_sse_body(stream, None))
                .expect("typed response");
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

fn responses_direct_output_response(
    frame: V3Server16HttpFrame,
    keepalive_interval: Duration,
) -> Response<Body> {
    responses_direct_output_response_with_console(frame, None, keepalive_interval)
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
    keepalive_interval: Duration,
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
            // Direct SSE 投影保真传输 provider 字节，同时由 server 注入 transport
            // keepalive：客户端 SSE 连接与 provider 状态解耦，provider 静默时
            // 连接仍存活（错误/超时走 runtime 错误链，不在此层造错误帧）。
            // Error06 终态错误帧（error_chain 非空）是 terminal 投影，保持
            // "错误事件即首事件"确定性，不注入 keepalive。
            let keepalive = if frame.error_chain.is_empty() {
                Some(keepalive_interval)
            } else {
                None
            };
            return builder
                .body(v3_client_sse_body(stream, keepalive))
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
                V3SseConsoleStreamTerminal::Dropped => finalizer.client_disconnected(),
            })
        }
        None => stream,
    }
}

type V3IoSseStream =
    std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, io::Error>> + Send>>;

fn v3_relay_client_sse_body(
    stream: V3ResponsesRelayClientStream,
    keepalive_interval: Option<Duration>,
) -> Body {
    let stream = stream::unfold((stream, false), |(mut stream, done)| async move {
        if done {
            return None;
        }
        match stream.next().await {
            Some(Ok(chunk)) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
            Some(Err(error)) => Some((Err(io::Error::other(error)), (stream, true))),
            None => None,
        }
    });
    v3_io_sse_body(Box::pin(stream), keepalive_interval)
}

fn v3_client_sse_body(stream: V3ClientSseStream, keepalive_interval: Option<Duration>) -> Body {
    let stream = stream::unfold((stream, false), |(mut stream, done)| async move {
        if done {
            return None;
        }
        match stream.next().await {
            Some(Ok(chunk)) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
            Some(Err(error)) => Some((Err(io::Error::other(error.message)), (stream, true))),
            None => None,
        }
    });
    v3_io_sse_body(Box::pin(stream), keepalive_interval)
}

fn v3_io_sse_body(stream: V3IoSseStream, keepalive_interval: Option<Duration>) -> Body {
    let Some(keepalive_interval) = keepalive_interval else {
        return Body::from_stream(stream);
    };
    let keepalive_chunk =
        build_v3_sse_transport_out_04_keepalive_comment(" keepalive").into_bytes();
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + keepalive_interval,
        keepalive_interval,
    );
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    Body::from_stream(stream::unfold(
        (stream, interval, true, keepalive_chunk),
        |(mut stream, mut interval, initial, keepalive_chunk)| async move {
            if initial {
                return Some((
                    Ok::<Vec<u8>, io::Error>(keepalive_chunk.clone()),
                    (stream, interval, false, keepalive_chunk),
                ));
            }
            tokio::select! {
                biased;
                item = stream.next() => item.map(|item| {
                    (item, (stream, interval, false, keepalive_chunk))
                }),
                _ = interval.tick() => Some((
                    Ok::<Vec<u8>, io::Error>(keepalive_chunk.clone()),
                    (stream, interval, false, keepalive_chunk),
                )),
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
            .unwrap_or(200) as usize,
        raw_response_retention: manifest
            .retention
            .get("raw_responses")
            .copied()
            .unwrap_or(200) as usize,
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
    responses_direct_output_response(frame, Duration::from_millis(server.http_sse_keepalive_ms))
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
    responses_direct_output_response(
        project_v3_responses_error_frame_for_request_if_sse(frame, request_headers, payload),
        Duration::from_millis(server.http_sse_keepalive_ms),
    )
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
mod tests;
