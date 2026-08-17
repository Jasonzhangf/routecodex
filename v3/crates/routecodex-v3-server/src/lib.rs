mod console;
mod endpoint_handlers;
mod executors;
mod frame_builders;
mod live_snapshot;
mod models_catalog;
mod request_id;
mod responses_direct_server_outcome;
mod scope_metadata;
mod session_admission;
mod websocket;

use console::*;
use endpoint_handlers::{
    allocate_v3_console_request_id, allocate_v3_console_request_identity,
    format_v3_request_id_entry, format_v3_request_id_token,
    merge_v3_direct_handoff_provider_failure_events, merge_v3_protocol_plan_trace,
    merge_v3_relay_handoff_provider_failure_events_into_direct_frame,
    next_v3_console_request_identity, pending_endpoint_after_responses_admission,
    prepend_v3_protocol_plan_trace_to_responses_relay_output,
    prepend_v3_relay_handoff_trace_to_direct_frame,
};
pub use executors::*;
pub(crate) use frame_builders::*;
pub(crate) use live_snapshot::*;
use request_id::{
    format_v3_tm, v3_request_id_clock_now, V3AllocatedRequestIdentity, V3RequestCounterState,
    V3RequestIdCounter,
};
pub(crate) use scope_metadata::*;
use websocket::{
    responses_websocket_endpoint, responses_websocket_session, send_responses_websocket_sse_stream,
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
    build_v3_provider_global_probe_target, build_v3_server_03_http_request_raw,
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
    execute_v3_responses_relay_runtime_with_default_transport,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_provider_snapshots_and_initial_target,
    probe_v3_provider_global_target, project_v3_anthropic_relay_runtime_failure,
    project_v3_debug_failure, project_v3_gemini_relay_runtime_failure,
    project_v3_openai_chat_relay_runtime_failure,
    project_v3_responses_previous_response_owner_resolution_error,
    project_v3_responses_relay_runtime_failure, project_v3_virtual_router_dry_run,
    project_v3_virtual_router_status, register_responses_direct_hooks,
    resolve_v3_responses_previous_response_owner_execution_mode_at_req03,
    V3AnthropicRelayClientHeader, V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput,
    V3ChatDirectCodec, V3ClientBody, V3ClientSseStream, V3FoundationRuntimeInput,
    V3FoundationRuntimeOutput, V3GeminiRelayClientBody, V3GeminiRelayRuntimeInput,
    V3GeminiRelayRuntimeOutput, V3OpenAiChatClientStream, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput, V3OpenAiChatRelayRuntimeOutput, V3Resp15ClientPayload,
    V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
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
    sse_dump_enabled: bool,
    request_counter: Arc<Mutex<V3RequestIdCounter>>,
    codex_sample_store: Arc<routecodex_v3_debug::V3CodexSampleStore>,
    responses_direct_continuation: Arc<V3ResponsesDirectContinuationState>,
    responses_direct_stopless_control: Arc<V3ResponsesDirectStoplessControlState>,
    responses_relay_local_continuation: Arc<V3ResponsesRelayLocalContinuationState>,
    responses_relay_stopless_control: Arc<V3ResponsesRelayStoplessControlState>,
    provider_health: Arc<V3ResponsesRelayProviderHealthHandle>,
    realtime_cooled_provider_keys: Arc<Mutex<BTreeSet<String>>>,
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
    probe_shutdown: Option<oneshot::Sender<()>>,
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
        if let Some(shutdown) = self.probe_shutdown.take() {
            let _ = shutdown.send(());
        }
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
    let sse_dump_enabled = v3_sse_dump_env_flag();
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
        routecodex_v3_config::internal::v3_error_samples_only()
            && !manifest.debug.full_codex_sampling,
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
            sse_dump_enabled,
            request_counter: Arc::clone(&request_counter),
            codex_sample_store: codex_sample_store.clone(),
            responses_direct_continuation: responses_direct_continuation.clone(),
            responses_direct_stopless_control: responses_direct_stopless_control.clone(),
            responses_relay_local_continuation: responses_relay_local_continuation.clone(),
            responses_relay_stopless_control: responses_relay_stopless_control.clone(),
            provider_health: provider_health.clone(),
            realtime_cooled_provider_keys: Arc::new(Mutex::new(BTreeSet::new())),
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
    let (probe_shutdown, mut probe_shutdown_rx) = oneshot::channel();
    let probe_manifest = Arc::clone(&manifest);
    let probe_health = Arc::clone(&provider_health).runtime_health();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = &mut probe_shutdown_rx => break,
                _ = interval.tick() => {
                    let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
                        Ok(duration) => duration.as_millis() as u64,
                        Err(error) => {
                            eprintln!("provider global probe clock failure: {error}");
                            continue;
                        }
                    };
                    let manifest_for_probe = Arc::clone(&probe_manifest);
                    let result = probe_health.run_due_global_subscription_probes(now_ms, move |provider_id, auth_alias, model_id| {
                        let manifest_for_probe = Arc::clone(&manifest_for_probe);
                        async move {
                            let target = build_v3_provider_global_probe_target(
                                &manifest_for_probe,
                                &provider_id,
                                auth_alias.as_deref(),
                                model_id.as_deref(),
                            )?;
                            probe_v3_provider_global_target(target).await
                        }
                    }).await;
                    if let Err(error) = result {
                        eprintln!("provider global probe cycle failed: {error}");
                    }
                    let manifest_for_probe = Arc::clone(&probe_manifest);
                    let result = probe_health.run_due_provider_cooldown_probes(now_ms, move |provider_id, auth_alias, model_id| {
                        let manifest_for_probe = Arc::clone(&manifest_for_probe);
                        async move {
                            let target = build_v3_provider_global_probe_target(
                                &manifest_for_probe,
                                &provider_id,
                                auth_alias.as_deref(),
                                model_id.as_deref(),
                            )?;
                            probe_v3_provider_global_target(target).await
                        }
                    }).await;
                    if let Err(error) = result {
                        eprintln!("provider cooldown probe cycle failed: {error}");
                    }
                }
            }
        }
    });
    Ok(V3ServerAggregateHandle {
        listeners,
        probe_shutdown: Some(probe_shutdown),
    })
}

pub async fn serve_v3_server_aggregate_until_shutdown(
    manifest: V3Config05ManifestPublished,
) -> Result<(), std::io::Error> {
    let handle = spawn_v3_server_aggregate(manifest).await?;
    tokio::signal::ctrl_c().await?;
    handle.shutdown().await;
    Ok(())
}

fn v3_sse_dump_env_flag() -> bool {
    let Ok(value) = std::env::var("ROUTECODEX_V3_SSE_DUMP") else {
        return false;
    };
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
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

/// v3.protocol.pending_projection：尚未实现协议绑定的客户端响应统一由
/// foundation pending 投影出站（见 v3-resource-operation-map.yml 同名资源）。
fn pending_binding_output_response(
    output: V3FoundationRuntimeOutput,
    _entry_protocol: &str,
    _pending_not_implemented: &str,
    _pending_owner: &str,
) -> Response<Body> {
    foundation_output_response(output)
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

#[cfg(test)]
mod tests;
