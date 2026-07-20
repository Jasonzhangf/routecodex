use axum::body::{to_bytes, Body};
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    ConnectInfo, Request, State,
};
use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Response, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{
    resolve_routecodex_package_version_from_executable, V3Config05ManifestPublished,
    V3DebugManifest, V3EntryProtocolExecutionMode, V3ServerManifest,
};
use routecodex_v3_debug::{
    V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_error::{
    project_v3_http_boundary_error, V3HttpBoundaryErrorKind, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw, execute_v3_anthropic_relay_runtime_with_default_transport,
    execute_v3_foundation_pending_runtime, execute_v3_gemini_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport,
    execute_v3_responses_direct_dry_run_runtime,
    execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation,
    execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control,
    execute_v3_responses_relay_runtime_with_default_transport,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control,
    execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots,
    project_v3_anthropic_relay_runtime_failure, project_v3_debug_failure,
    project_v3_gemini_relay_runtime_failure, project_v3_openai_chat_relay_runtime_failure,
    project_v3_responses_relay_runtime_failure, project_v3_virtual_router_dry_run,
    project_v3_virtual_router_status, register_responses_direct_hooks,
    V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput, V3ClientBody, V3ClientSseStream,
    V3FoundationRuntimeInput, V3FoundationRuntimeOutput, V3GeminiRelayClientBody,
    V3GeminiRelayRuntimeInput, V3GeminiRelayRuntimeOutput, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput, V3OpenAiChatRelayRuntimeOutput, V3Resp15ClientPayload,
    V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
    V3ResponsesRelayClientBody, V3ResponsesRelayClientStream,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayRuntimeOutput, V3ResponsesRelayStoplessControlState, V3RuntimeObservability,
    V3RuntimeStreamObservation, V3RuntimeUsageSummary,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, build_v3_sse_transport_in_02_from_fields,
    build_v3_sse_transport_in_03_from_v3_sse_transport_in_02,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03, SseField, SseIncrementalDecoder,
    SseTransportLimits,
};
use serde_json::{json, Map, Value};
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
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const V3_PROTOCOL_PENDING_PROJECTION_RESOURCE: &str = "v3.protocol.pending_projection";

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
}

#[derive(Debug, Default, Clone)]
struct V3RequestCounterState {
    total_count: u64,
    window_count: u64,
    window_key: String,
    updated_at: String,
}

#[derive(Debug)]
struct V3RequestIdCounter {
    state_file: PathBuf,
    state: V3RequestCounterState,
    loaded: bool,
}

impl V3RequestIdCounter {
    fn new() -> Self {
        Self {
            state_file: resolve_v3_request_id_counter_file(),
            state: V3RequestCounterState::default(),
            loaded: false,
        }
    }

    fn next_request_id(
        &mut self,
        entry: &str,
        provider: &str,
        model: &str,
    ) -> Result<String, String> {
        let clock = v3_request_id_clock_now()?;
        self.ensure_loaded(&clock)?;
        if self.state.window_key != clock.local_date_key {
            self.state.window_key = clock.local_date_key.clone();
            self.state.window_count = 0;
        }
        self.state.total_count = self
            .state
            .total_count
            .checked_add(1)
            .ok_or_else(|| "V3 request id total counter overflowed".to_string())?;
        self.state.window_count = self
            .state
            .window_count
            .checked_add(1)
            .ok_or_else(|| "V3 request id daily counter overflowed".to_string())?;
        self.state.updated_at = clock.utc_iso.clone();
        self.persist()?;
        Ok(format!(
            "{entry}-{provider}-{model}-{}-{}-{}",
            clock.local_timestamp, self.state.total_count, self.state.window_count
        ))
    }

    fn ensure_loaded(&mut self, clock: &V3RequestIdClock) -> Result<(), String> {
        if self.loaded {
            return Ok(());
        }
        if !self.state_file.exists() {
            self.state = V3RequestCounterState {
                total_count: 0,
                window_count: 0,
                window_key: clock.local_date_key.clone(),
                updated_at: clock.utc_iso.clone(),
            };
            self.loaded = true;
            return Ok(());
        }
        let mut file = fs::File::open(&self.state_file).map_err(|error| {
            format!(
                "failed to read V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|error| {
            format!(
                "failed to read V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "failed to parse V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })?;
        let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version != 1 {
            return Err(format!(
                "unsupported V3 request id counter version {version} in {}",
                self.state_file.display()
            ));
        }
        let total_count = value
            .get("totalCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                format!(
                    "V3 request id counter {} is missing totalCount",
                    self.state_file.display()
                )
            })?;
        let window_count = value
            .get("windowCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                format!(
                    "V3 request id counter {} is missing windowCount",
                    self.state_file.display()
                )
            })?;
        let window_key = value
            .get("windowKey")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "V3 request id counter {} is missing windowKey",
                    self.state_file.display()
                )
            })?
            .to_string();
        let updated_at = value
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.state = V3RequestCounterState {
            total_count,
            window_count,
            window_key,
            updated_at,
        };
        self.loaded = true;
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self.state_file.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create V3 request id counter directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let body = json!({
            "version": 1,
            "totalCount": self.state.total_count,
            "windowCount": self.state.window_count,
            "windowKey": self.state.window_key,
            "updatedAt": self.state.updated_at,
        });
        let tmp = self
            .state_file
            .with_extension(format!("json.tmp.{}", std::process::id()));
        let encoded = serde_json::to_vec_pretty(&body)
            .map_err(|error| format!("failed to serialize V3 request id counter: {error}"))?;
        fs::write(&tmp, encoded).map_err(|error| {
            format!(
                "failed to write V3 request id counter temp file {}: {error}",
                tmp.display()
            )
        })?;
        fs::rename(&tmp, &self.state_file).map_err(|error| {
            format!(
                "failed to publish V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })
    }
}

#[derive(Debug)]
struct V3RequestIdClock {
    local_timestamp: String,
    local_date_key: String,
    utc_iso: String,
}

fn resolve_v3_request_id_counter_file() -> PathBuf {
    if let Some(path) = non_empty_env_path("ROUTECODEX_REQUEST_ID_COUNTER_FILE")
        .or_else(|| non_empty_env_path("RCC_REQUEST_ID_COUNTER_FILE"))
    {
        return path;
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".rcc")
        .join("state")
        .join("request-id-counter.json")
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn v3_request_id_clock_now() -> Result<V3RequestIdClock, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("V3 request id clock moved backwards: {error}"))?;
    let epoch_ms = duration.as_millis();
    let seconds = (epoch_ms / 1000) as libc::time_t;
    let millis = (epoch_ms % 1000) as u32;
    let local = format_v3_tm(seconds, true)?;
    let utc = format_v3_tm(seconds, false)?;
    Ok(V3RequestIdClock {
        local_timestamp: format!(
            "{:04}{:02}{:02}T{:02}{:02}{:02}{:03}",
            local.year, local.month, local.day, local.hour, local.minute, local.second, millis
        ),
        local_date_key: format!("{:04}{:02}{:02}", local.year, local.month, local.day),
        utc_iso: format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            utc.year, utc.month, utc.day, utc.hour, utc.minute, utc.second, millis
        ),
    })
}

#[derive(Debug)]
struct V3RequestIdTm {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
}

fn format_v3_tm(seconds: libc::time_t, local: bool) -> Result<V3RequestIdTm, String> {
    let mut raw = std::mem::MaybeUninit::<libc::tm>::uninit();
    let result = unsafe {
        if local {
            libc::localtime_r(&seconds, raw.as_mut_ptr())
        } else {
            libc::gmtime_r(&seconds, raw.as_mut_ptr())
        }
    };
    if result.is_null() {
        return Err("failed to format V3 request id timestamp".to_string());
    }
    let tm = unsafe { raw.assume_init() };
    Ok(V3RequestIdTm {
        year: tm.tm_year + 1900,
        month: tm.tm_mon + 1,
        day: tm.tm_mday,
        hour: tm.tm_hour,
        minute: tm.tm_min,
        second: tm.tm_sec,
    })
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
    json_response(200, build_v3_models_catalog(&state.manifest))
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
    match project_v3_virtual_router_status(&state.manifest, &state.server.id) {
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
                &path,
                &request_id,
                frame.status,
                &frame.error_chain,
                match &frame.body {
                    V3Server16Body::Json(value) => Some(value),
                    V3Server16Body::Bytes(_) | V3Server16Body::Sse(_) => None,
                },
            ) {
                return response;
            }
            return responses_direct_output_response(frame);
        }
    };
    let request_id = match allocate_v3_console_request_id(&state, &path, Some(&payload)) {
        Ok(request_id) => request_id,
        Err(response) => return *response,
    };
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
    emit_v3_request_start_console_line(&state, &path, &request_id, &request_headers, &payload);
    if is_provider_request_dry_run(&request_headers)
        && entry_protocol == "responses"
        && execution_mode == V3EntryProtocolExecutionMode::Direct
    {
        let output = execute_v3_responses_direct_dry_run_runtime(
            V3DryRunFixture {
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
            },
            &state.manifest,
            &state.debug,
        )
        .await;
        let observability = build_v3_foundation_console_observability(&state, &output);
        let console_context = build_v3_console_emission_context(
            &state,
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
                return error_output_response_for_server(
                    &state.server,
                    &path,
                    &request_id,
                    project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
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
        let output = execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control(
            &state.manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: state.server.id.clone(),
                request_id: request_id.clone(),
                payload: payload.clone(),
            },
            &state.responses_relay_local_continuation,
            &state.responses_relay_stopless_control,
            continuation_scope,
            now_epoch_ms,
        )
        .await;
        let observability = build_v3_foundation_console_observability(&state, &output);
        let console_context = build_v3_console_emission_context(
            &state,
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
                &path,
                &request_id,
                output.status,
                error_chain,
                openai_chat_error_body_for_console(&output.client_body),
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
                &path,
                &request_id,
                output.status,
                error_chain,
                Some(&output.client_response),
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
                &path,
                &request_id,
                output.status,
                error_chain,
                gemini_error_body_for_console(&output.client_body),
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
                return error_output_response_for_server(
                    &state.server,
                    &path,
                    &request_id,
                    project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
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
            match execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots(
                &state.manifest,
                runtime_input,
                &state.provider_health,
                &state.responses_relay_local_continuation,
                &state.responses_relay_stopless_control,
                continuation_scope,
                now_epoch_ms,
                capture_provider_request,
                capture_provider_response,
            )
            .await
            {
                Ok(output) => output,
                Err(error) => project_v3_responses_relay_runtime_failure(error),
            }
        } else {
            match execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control(
                &state.manifest,
                runtime_input,
                &state.provider_health,
                &state.responses_relay_local_continuation,
                &state.responses_relay_stopless_control,
                continuation_scope,
                now_epoch_ms,
            )
            .await
            {
                Ok(output) => output,
                Err(error) => project_v3_responses_relay_runtime_failure(error),
            }
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
                &path,
                &request_id,
                output.status,
                error_chain,
                relay_error_body_for_console(&output.client_body),
            ) {
                return response;
            }
        }
        let console_context = build_v3_console_emission_context(
            &state,
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
        let frame = execute_responses_direct_server_frame(
            &state,
            &request_headers,
            method,
            path.clone(),
            request_id.clone(),
            execution_id,
            payload,
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
        emit_v3_frame_error_console_line(&state.server, &path, &request_id, &frame);
        responses_direct_output_response(frame)
    } else if execution_mode == V3EntryProtocolExecutionMode::PendingNotImplemented {
        let pending_not_implemented = execution_mode.as_str();
        let Some(pending_owner) = pending_owner_symbol else {
            return error_output_response_for_server(
                &state.server,
                &path,
                &request_id,
                project_http_input_error(
                    V3HttpBoundaryErrorKind::EndpointNotEnabled,
                    format!(
                        "entry protocol {entry_protocol} pending binding lacks explicit pending owner"
                    ),
                ),
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
        error_output_response_for_server(
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
        )
    }
}

fn is_provider_request_dry_run(headers: &HeaderMap) -> bool {
    headers
        .get("x-routecodex-dry-run")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("provider-request"))
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
        emit_v3_error_console_line(
            &state.server,
            endpoint,
            "request-id-unavailable",
            output.status,
            &output.error_chain,
            Some(&output.body),
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
        &payload,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            return build_v3_server_16_http_frame_from_v3_error_06(project_http_input_error(
                V3HttpBoundaryErrorKind::MalformedJson,
                message,
            ));
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
            );
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

fn record_and_emit_v3_error_projection(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) -> Option<Response<Body>> {
    if let Err(error) = state.debug.record_node_event(
        trace_scope,
        "V3Error06ClientProjected",
        "projected",
        Some(json!({
            "status": status,
            "error_chain": error_chain,
            "body": body
        })),
    ) {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3Error06ClientProjected",
            error,
        )));
    }
    emit_v3_error_console_line(
        &state.server,
        endpoint,
        request_id,
        status,
        error_chain,
        body,
    );
    None
}

#[derive(Clone)]
struct V3LiveSnapClientResponseSseRecorder {
    state: Arc<V3ListenerState>,
    entry_protocol: String,
    endpoint: String,
    request_id: String,
    status: u16,
    node_trace: Vec<&'static str>,
    error_chain: Option<Vec<&'static str>>,
    observability: Option<Value>,
    raw_sse: Arc<Mutex<String>>,
    stream_error: Arc<Mutex<Option<String>>>,
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
            raw_sse: Arc::new(Mutex::new(String::new())),
            stream_error: Arc::new(Mutex::new(None)),
        }
    }

    fn wrap(&self, stream: V3ResponsesRelayClientStream) -> V3ResponsesRelayClientStream {
        let recorder = self.clone();
        Box::pin(stream.map(move |chunk| match chunk {
            Ok(bytes) => recorder.append_chunk(&bytes).map(|_| bytes),
            Err(error) => recorder.record_stream_error(&error).and(Err(error)),
        }))
    }

    fn persist_initial(&self) -> Result<(), String> {
        self.persist_current()
    }

    fn append_chunk(&self, bytes: &[u8]) -> Result<(), String> {
        {
            let mut raw_sse = self.raw_sse.lock().map_err(|error| error.to_string())?;
            raw_sse.push_str(&String::from_utf8_lossy(bytes));
        }
        self.persist_current()
    }

    fn record_stream_error(&self, error: &str) -> Result<(), String> {
        {
            let mut stream_error = self
                .stream_error
                .lock()
                .map_err(|lock_error| lock_error.to_string())?;
            *stream_error = Some(error.to_string());
        }
        self.persist_current()
    }

    fn persist_current(&self) -> Result<(), String> {
        let raw_sse = self
            .raw_sse
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let stream_error = self
            .stream_error
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let mut payload = json!({
            "object": "routecodex.v3.client_response_snapshot",
            "stage": "client-response",
            "source": "live_server_response_stream",
            "status": self.status,
            "bodyKind": "sse",
            "rawSse": raw_sse,
            "node_trace": self.node_trace.clone(),
            "error_chain": self.error_chain.clone(),
            "observability": self.observability.clone(),
        });
        if let Some(stream_error) = stream_error {
            if let Some(object) = payload.as_object_mut() {
                object.insert("streamError".to_string(), Value::String(stream_error));
            }
        }
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

fn capture_v3_responses_relay_provider_snapshots(
    state: &V3ListenerState,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &V3ResponsesRelayRuntimeOutput,
) -> Option<Response<Body>> {
    if !state
        .debug
        .should_capture_snapshot_stage("provider-request")
        && !state
            .debug
            .should_capture_snapshot_stage("provider-response")
    {
        return None;
    }
    let Some(snapshots) = output.provider_snapshots.as_ref() else {
        return None;
    };
    if let Some(provider_request) = snapshots.provider_request.as_ref() {
        if state
            .debug
            .should_capture_snapshot_stage("provider-request")
        {
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
    if let Some(provider_response) = snapshots.provider_response.as_ref() {
        if state
            .debug
            .should_capture_snapshot_stage("provider-response")
        {
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
        "usage": observability.usage.as_ref().map(project_v3_runtime_usage_debug),
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
    let Some(root) = std::env::var_os("HOME") else {
        return Ok(());
    };
    let dir = PathBuf::from(root)
        .join(".rcc")
        .join("codex-samples")
        .join(format_v3_codex_sample_endpoint_dir(
            entry_protocol,
            endpoint,
        ))
        .join("ports")
        .join(state.server.port.to_string())
        .join(encode_v3_codex_sample_path_segment(request_id));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(file_name);
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut file, payload).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    Ok(())
}

fn format_v3_codex_sample_endpoint_dir(entry_protocol: &str, endpoint: &str) -> String {
    match (entry_protocol, endpoint) {
        ("responses", "/v1/responses") => "openai-responses".to_string(),
        ("openai_chat", "/v1/chat/completions") => "openai-chat-completions".to_string(),
        ("anthropic", "/v1/messages") => "anthropic-messages".to_string(),
        ("gemini", _) => "gemini-generate-content".to_string(),
        _ => encode_v3_codex_sample_path_segment(
            endpoint.trim_start_matches('/').replace('/', "-").as_str(),
        ),
    }
}

fn encode_v3_codex_sample_path_segment(value: &str) -> String {
    let path_safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if path_safe.is_empty() {
        "unknown".to_string()
    } else {
        path_safe
    }
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

fn emit_v3_request_start_console_line(
    state: &V3ListenerState,
    endpoint: &str,
    request_id: &str,
    headers: &HeaderMap,
    payload: &Value,
) {
    if !state.console_enabled {
        return;
    }
    let stream = payload.get("stream").and_then(Value::as_bool) == Some(true);
    let accepts_sse = request_accepts_sse(headers) || stream;
    let raw_input_items = response_input_item_count(payload.get("input"));
    let line = format!(
        "[{}] ▶ [{}] {} request {} started (stream={} acceptsSse={} rawInputItems={} preparedInputItems={} plannedEntryMode=none)",
        state.server.port,
        endpoint,
        console_timestamp_hhmmss(),
        request_id,
        stream,
        accepts_sse,
        raw_input_items,
        raw_input_items
    );
    let color_key = resolve_v3_log_session_color_key(headers, payload, request_id);
    append_v3_human_console_line(state, &line);
    println!(
        "{}",
        colorize_v3_request_console_line(&line, color_key.as_deref())
    );
}

#[derive(Clone)]
struct V3ConsoleEmissionContext {
    state: Arc<V3ListenerState>,
    endpoint: String,
    request_id: String,
    headers: HeaderMap,
    payload: Value,
}

fn build_v3_console_emission_context(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    request_id: &str,
    headers: &HeaderMap,
    payload: &Value,
) -> V3ConsoleEmissionContext {
    V3ConsoleEmissionContext {
        state: Arc::clone(state),
        endpoint: endpoint.to_string(),
        request_id: request_id.to_string(),
        headers: headers.clone(),
        payload: payload.clone(),
    }
}

fn emit_v3_request_route_console_line(
    context: &V3ConsoleEmissionContext,
    observability: &V3RuntimeObservability,
) {
    if !context.state.console_enabled {
        return;
    }
    let route = observability
        .routing_group_id
        .as_deref()
        .unwrap_or(&context.state.server.routing_group);
    let pool = observability.pool_id.as_deref().unwrap_or("-");
    let provider = observability.provider_id.as_deref().unwrap_or("-");
    let provider_key = observability.provider_key.as_deref().unwrap_or(provider);
    let model = format_v3_console_model_pair(observability);
    let provider_type = observability.provider_type.as_deref().unwrap_or("-");
    let attempts = observability.attempts.unwrap_or(1);
    let target_path = if observability.target_path.is_empty() {
        "-".to_string()
    } else {
        observability.target_path.join(">")
    };
    let unavailable = if observability.unavailable_candidates.is_empty() {
        "-".to_string()
    } else {
        observability.unavailable_candidates.join("|")
    };
    let line = format!(
        "[{}] 🎯 [{}] {} request {} route={} pool={} provider={} providerKey={} model={} type={} attempts={} unavailable={} path={} transport={}",
        context.state.server.port,
        context.endpoint,
        console_timestamp_hhmmss(),
        context.request_id,
        route,
        pool,
        provider,
        provider_key,
        model,
        provider_type,
        attempts,
        unavailable,
        target_path,
        observability.transport
    );
    let color_key =
        resolve_v3_log_session_color_key(&context.headers, &context.payload, &context.request_id);
    append_v3_human_console_line(&context.state, &line);
    println!(
        "{}",
        colorize_v3_request_console_line(&line, color_key.as_deref())
    );
}

fn emit_v3_request_complete_console_line(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    elapsed: std::time::Duration,
) {
    if !context.state.console_enabled {
        return;
    }
    let response_status = observability
        .response_status
        .as_deref()
        .unwrap_or("completed");
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .unwrap_or("unreported");
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    let line = format!(
        "[{}] ✅ [{}] {} request {} completed (status={}{} responseStatus={} finishReason={} elapsedMs={:.1} nodes={} transport={})",
        context.state.server.port,
        context.endpoint,
        console_timestamp_hhmmss(),
        context.request_id,
        status,
        format_v3_console_upstream_status_suffix(status, observability.provider_status),
        response_status,
        finish_reason,
        elapsed_ms,
        node_trace.len(),
        observability.transport
    );
    let color_key =
        resolve_v3_log_session_color_key(&context.headers, &context.payload, &context.request_id);
    append_v3_human_console_line(&context.state, &line);
    println!(
        "{}",
        colorize_v3_request_console_line(&line, color_key.as_deref())
    );
}

fn emit_v3_usage_console_line(
    context: &V3ConsoleEmissionContext,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    elapsed: std::time::Duration,
) {
    if !context.state.console_enabled {
        return;
    }
    let route = observability
        .routing_group_id
        .as_deref()
        .unwrap_or(&context.state.server.routing_group);
    let provider = observability.provider_id.as_deref().unwrap_or("-");
    let model = format_v3_console_model_pair(observability);
    let usage = format_v3_console_usage_summary(observability.usage.as_ref());
    let finish_reason = observability
        .finish_reason
        .as_deref()
        .unwrap_or("unreported");
    let counts = v3_console_pipeline_counts(node_trace);
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    let line = format!(
        "[{}] [usage] req={} endpoint={} route={} provider={} model={} usage={} finishReason={} time=t:{:.1}ms pipeline=nodes:{} req:{} resp:{} provider:{} error:{}",
        context.state.server.port,
        context.request_id,
        context.endpoint,
        route,
        provider,
        model,
        usage,
        finish_reason,
        elapsed_ms,
        node_trace.len(),
        counts.request,
        counts.response,
        counts.provider,
        counts.error
    );
    let color_key =
        resolve_v3_log_session_color_key(&context.headers, &context.payload, &context.request_id);
    append_v3_human_console_line(&context.state, &line);
    println!(
        "{}",
        colorize_v3_request_console_line(&line, color_key.as_deref())
    );
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
        .unwrap_or("unreported");
    let line = format!(
        "[{}] 🧭 [stopless] {} request {} activated (hook=reasoningStop callId=call_stopless_reasoning action=exec_command finishReason={} transport={})",
        context.state.server.port,
        console_timestamp_hhmmss(),
        context.request_id,
        finish_reason,
        observability.transport
    );
    append_v3_human_console_line(&context.state, &line);
    println!("{}", colorize_v3_stopless_console_line(&line));
}

fn is_v3_stopless_console_activation(observability: &V3RuntimeObservability) -> bool {
    observability.stopless_activation
}

fn append_v3_human_console_line(state: &V3ListenerState, line: &str) {
    if let Err(error) = state.debug.append_human_console_line(line) {
        eprintln!(
            "{}",
            colorize_v3_error_console_line(&format!(
                "[{}] ❌ [debug] {} request debug-log failed (status=500 error=V3E00 subcode=debug_sink node=V3DebugEventLedgerRecorded) {}",
                state.server.port,
                console_timestamp_hhmmss(),
                error
            ))
        );
    }
}

fn emit_v3_observability_console_lines(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: &V3RuntimeObservability,
    started_at: Instant,
    include_usage: bool,
) {
    emit_v3_request_route_console_line(context, observability);
    if include_usage {
        let elapsed = started_at.elapsed();
        emit_v3_stopless_console_line(context, observability);
        if should_emit_v3_request_complete_console_line(status, observability) {
            emit_v3_request_complete_console_line(
                context,
                status,
                node_trace,
                observability,
                elapsed,
            );
        }
        emit_v3_usage_console_line(context, node_trace, observability, elapsed);
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

const V3_SSE_CLIENT_DISCONNECTED_MESSAGE: &str =
    "client disconnected before provider SSE stream completed";
const V3_SSE_PROVIDER_ENDED_WITHOUT_TERMINAL_MESSAGE: &str =
    "provider SSE stream ended before response.completed";
const V3_SSE_PROVIDER_FAILED_WITHOUT_COMPLETION_MESSAGE: &str =
    "provider SSE stream failed before response.completed";

#[derive(Debug, Clone, PartialEq, Eq)]
enum V3SseConsoleStreamTerminal {
    Completed,
    Failed(String),
    Dropped,
}

impl V3SseConsoleFinalizer {
    fn complete(mut self) {
        match self.stream_observation.snapshot() {
            Ok(snapshot) => {
                if snapshot.response_status.is_some() {
                    self.observability.response_status = snapshot.response_status;
                }
                if snapshot.finish_reason.is_some() {
                    self.observability.finish_reason = snapshot.finish_reason;
                }
                if snapshot.usage.is_some() {
                    self.observability.usage = snapshot.usage;
                }
                let elapsed = self.started_at.elapsed();
                emit_v3_stopless_console_line(&self.context, &self.observability);
                emit_v3_request_complete_console_line(
                    &self.context,
                    self.status,
                    &self.node_trace,
                    &self.observability,
                    elapsed,
                );
                emit_v3_usage_console_line(
                    &self.context,
                    &self.node_trace,
                    &self.observability,
                    elapsed,
                );
            }
            Err(error) => self.provider_stream_failed(&error),
        }
    }

    fn provider_stream_failed(self, error: &str) {
        self.fail(502, "provider_response_sse_stream", error);
    }

    fn client_disconnected(self) {
        self.fail(499, "client_disconnect", V3_SSE_CLIENT_DISCONNECTED_MESSAGE);
    }

    fn fail(self, status: u16, code: &str, message: &str) {
        let body = json!({
            "error": {
                "code": code,
                "message": message
            }
        });
        emit_v3_error_console_line_with_port(
            &self.context.state.server.port.to_string(),
            &self.context.endpoint,
            &self.context.request_id,
            status,
            &V3_ERROR_CHAIN_NODE_IDS,
            Some(&body),
        );
    }
}

#[derive(Debug, Clone, Copy)]
struct V3ConsolePipelineCounts {
    request: usize,
    response: usize,
    provider: usize,
    error: usize,
}

fn v3_console_pipeline_counts(node_trace: &[&'static str]) -> V3ConsolePipelineCounts {
    let mut counts = V3ConsolePipelineCounts {
        request: 0,
        response: 0,
        provider: 0,
        error: 0,
    };
    for node in node_trace {
        if node.contains("Req") || node.contains("Request") {
            counts.request += 1;
        }
        if node.contains("Resp") || node.contains("Response") {
            counts.response += 1;
        }
        if node.contains("Provider") || node.contains("Transport") {
            counts.provider += 1;
        }
        if node.contains("Error") {
            counts.error += 1;
        }
    }
    counts
}

fn format_v3_console_model_pair(observability: &V3RuntimeObservability) -> String {
    match (
        observability.model_id.as_deref(),
        observability.wire_model.as_deref(),
    ) {
        (Some(model), Some(wire)) if model != wire => format!("{model}->{wire}"),
        (Some(model), _) => model.to_string(),
        (_, Some(wire)) => wire.to_string(),
        _ => "-".to_string(),
    }
}

fn format_v3_console_usage_summary(usage: Option<&V3RuntimeUsageSummary>) -> String {
    let Some(usage) = usage else {
        return "unreported".to_string();
    };
    let input_tokens = usage.input_tokens;
    let input = input_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let output = usage
        .output_tokens
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unreported".to_string());
    let total = usage
        .total_tokens
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
    format!("in:{input} out:{output} cache={cache} total={total}")
}

fn build_v3_foundation_console_observability(
    state: &V3ListenerState,
    output: &V3FoundationRuntimeOutput,
) -> V3RuntimeObservability {
    let provider_request = output
        .body
        .get("providerRequest")
        .or_else(|| output.body.pointer("/dry_run/provider_request"))
        .unwrap_or(&Value::Null);
    let provider_id = provider_request
        .get("providerId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let model_id = provider_request
        .pointer("/body/model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let transport = provider_request
        .get("streamIntent")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("json")
        .to_string();
    let response_status = output
        .body
        .pointer("/dry_run/response_payload/status")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            output
                .body
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let finish_reason = output
        .body
        .pointer("/dry_run/response_payload")
        .and_then(read_v3_console_finish_reason)
        .or_else(|| read_v3_console_finish_reason(&output.body));
    let usage = output
        .body
        .pointer("/dry_run/response_payload")
        .and_then(extract_v3_console_usage_summary);
    V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
        execution_mode: "direct".to_string(),
        transport,
        routing_group_id: Some(state.server.routing_group.clone()),
        pool_id: Some("dry_run".to_string()),
        provider_key: provider_id
            .as_ref()
            .map(|provider| match model_id.as_deref() {
                Some(model) => format!("{provider}:dry-run:{model}"),
                None => provider.clone(),
            }),
        provider_type: Some("responses".to_string()),
        provider_id,
        auth_alias: Some("dry-run".to_string()),
        model_id: model_id.clone(),
        wire_model: model_id,
        provider_status: Some(output.status),
        response_status,
        finish_reason,
        stopless_activation: false,
        attempts: Some(1),
        unavailable_candidates: Vec::new(),
        target_path: vec!["dry_run:provider_request".to_string()],
        usage,
    }
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
        match &frame.body {
            V3Server16Body::Json(value) => Some(value),
            V3Server16Body::Bytes(_) | V3Server16Body::Sse(_) => None,
        },
    );
}

fn emit_v3_error_console_line(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) {
    emit_v3_error_console_line_with_port(
        &server.port.to_string(),
        endpoint,
        request_id,
        status,
        error_chain,
        body,
    );
}

fn emit_v3_error_console_line_with_port(
    port_label: &str,
    endpoint: &str,
    request_id: &str,
    status: u16,
    error_chain: &[&'static str],
    body: Option<&Value>,
) {
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
    let line = format!(
        "[{}] ❌ [{}] {} request {} failed (status={} error={} subcode={} node={}) {}",
        port_label,
        endpoint,
        console_timestamp_hhmmss(),
        request_id,
        status,
        error_number,
        error_code,
        error_node,
        message
    );
    eprintln!("{}", colorize_v3_error_console_line(&line));
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
    println!(
        "[RouteCodexV3] Server started version={} crate={} binary={} on {addresses}",
        executable
            .as_deref()
            .and_then(resolve_routecodex_package_version_from_executable)
            .unwrap_or_else(|| "unknown".to_string()),
        env!("CARGO_PKG_VERSION"),
        binary
    );
}

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_WHITE: &str = "\x1b[97m";
const ANSI_ERROR_RED: &str = "\x1b[31m";
const ANSI_STOPLESS_PURPLE: &str = "\x1b[35m";

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

fn colorize_v3_request_console_line(line: &str, color_key: Option<&str>) -> String {
    if !is_v3_console_color_enabled() {
        return line.to_string();
    }
    let color = color_key
        .and_then(resolve_v3_session_color)
        .unwrap_or_else(|| "\x1b[36m".to_string());
    format!(
        "{}{}{}",
        color,
        highlight_v3_console_key_values(line, &color),
        ANSI_RESET
    )
}

fn colorize_v3_error_console_line(line: &str) -> String {
    if !is_v3_console_color_enabled() {
        return line.to_string();
    }
    format!(
        "{}{}{}",
        ANSI_ERROR_RED,
        highlight_v3_console_key_values(line, ANSI_ERROR_RED),
        ANSI_RESET
    )
}

fn colorize_v3_stopless_console_line(line: &str) -> String {
    if !is_v3_console_color_enabled() {
        return line.to_string();
    }
    format!(
        "{}{}{}",
        ANSI_STOPLESS_PURPLE,
        highlight_v3_console_key_values(line, ANSI_STOPLESS_PURPLE),
        ANSI_RESET
    )
}

fn highlight_v3_console_key_values(line: &str, base_color: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut remaining = line;
    while let Some(index) = remaining.find('=') {
        let (before_equal, after_equal) = remaining.split_at(index);
        let key_start = before_equal
            .rfind(|character: char| {
                !(character.is_ascii_alphanumeric() || character == '_' || character == '.')
            })
            .map(|position| position + 1)
            .unwrap_or(0);
        let key = &before_equal[key_start..];
        if key.is_empty() || !is_v3_console_highlight_key(key) {
            output.push_str(&remaining[..index + 1]);
            remaining = &after_equal[1..];
            continue;
        }
        let value = &after_equal[1..];
        let value_end = value.find([' ', ',', ')', ']']).unwrap_or(value.len());
        output.push_str(&before_equal[..key_start]);
        output.push_str(ANSI_WHITE);
        output.push_str(key);
        output.push('=');
        output.push_str(&value[..value_end]);
        output.push_str(ANSI_RESET);
        output.push_str(base_color);
        remaining = &value[value_end..];
    }
    output.push_str(remaining);
    output
}

fn is_v3_console_highlight_key(key: &str) -> bool {
    matches!(
        key,
        "stream"
            | "acceptsSse"
            | "timeoutMs"
            | "rawInputItems"
            | "preparedInputItems"
            | "plannedEntryMode"
            | "resumeFullInputItems"
            | "resumeDeltaInputItems"
            | "status"
            | "code"
            | "error"
            | "subcode"
            | "node"
            | "errorNode"
            | "errorChain"
            | "model"
            | "wire"
            | "type"
            | "provider"
            | "providerKey"
            | "providerStatus"
            | "responseStatus"
            | "finishReason"
            | "route"
            | "routeName"
            | "pool"
            | "path"
            | "attempts"
            | "unavailable"
            | "transport"
            | "elapsedMs"
            | "nodes"
            | "endpoint"
            | "req"
            | "usage"
            | "time"
            | "pipeline"
            | "target"
            | "upstreamStatus"
            | "upstreamCode"
            | "hook"
            | "callId"
            | "action"
    )
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
    .or_else(|| read_first_scope_value(Some(payload), BODY_WORKDIR_PATHS));
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
        .map(|duration| duration.as_secs() % 86_400)
        .unwrap_or(0);
    let hour = seconds / 3_600;
    let minute = (seconds % 3_600) / 60;
    let second = seconds % 60;
    format!("{hour:02}:{minute:02}:{second:02}")
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
    payload_input_has_unpaired_function_call_output(payload.get("input"))
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
    execute_v3_responses_relay_runtime_with_default_transport(manifest, input).await
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
        V3ResponsesRelayClientBody::Sse(client_stream) => Body::from_stream(
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
    decoder: SseIncrementalDecoder,
    observed_terminal_frame: Option<V3SseConsoleStreamTerminal>,
}

impl V3SseConsoleCloseoutStream {
    fn emit_terminal(&mut self, terminal: V3SseConsoleStreamTerminal) {
        if let Some(closeout) = self.closeout.take() {
            closeout(terminal);
        }
    }

    fn observe_chunk_terminal(&mut self, chunk: &[u8]) {
        let Ok(frames) = self
            .decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        else {
            return;
        };
        for frame in frames {
            let mut event_type: Option<String> = None;
            let mut data = String::new();
            for field in frame.frame().fields() {
                let SseField::Named { name, value } = field else {
                    continue;
                };
                match name.as_str() {
                    "event" => event_type = Some(value.to_string()),
                    "data" => {
                        if !data.is_empty() {
                            data.push('\n');
                        }
                        data.push_str(value);
                    }
                    _ => {}
                }
            }
            let Some(terminal) = v3_sse_console_terminal_from_frame(event_type.as_deref(), &data)
            else {
                continue;
            };
            if !matches!(
                self.observed_terminal_frame,
                Some(V3SseConsoleStreamTerminal::Failed(_))
            ) {
                self.observed_terminal_frame = Some(terminal);
            }
        }
    }
}

fn v3_sse_console_terminal_from_frame(
    event_type: Option<&str>,
    data: &str,
) -> Option<V3SseConsoleStreamTerminal> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(data).ok();
    let semantic_event_type = event_type.or_else(|| {
        parsed
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
    });
    match semantic_event_type {
        Some("response.completed" | "response.done" | "response.requires_action") => {
            Some(V3SseConsoleStreamTerminal::Completed)
        }
        Some("response.failed" | "response.incomplete" | "response.error") => {
            Some(V3SseConsoleStreamTerminal::Failed(
                parsed
                    .as_ref()
                    .and_then(read_v3_sse_console_failure_message)
                    .unwrap_or_else(|| {
                        V3_SSE_PROVIDER_FAILED_WITHOUT_COMPLETION_MESSAGE.to_string()
                    }),
            ))
        }
        _ => None,
    }
}

fn read_v3_sse_console_failure_message(event: &Value) -> Option<String> {
    event
        .pointer("/response/error/message")
        .or_else(|| event.pointer("/error/message"))
        .or_else(|| event.pointer("/response/incomplete_details/reason"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .map(str::to_string)
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
            Poll::Ready(Some(Ok(chunk))) => {
                this.observe_chunk_terminal(&chunk);
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.emit_terminal(V3SseConsoleStreamTerminal::Failed(error.clone()));
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                let terminal = this.observed_terminal_frame.clone().unwrap_or_else(|| {
                    V3SseConsoleStreamTerminal::Failed(
                        V3_SSE_PROVIDER_ENDED_WITHOUT_TERMINAL_MESSAGE.to_string(),
                    )
                });
                this.emit_terminal(terminal);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for V3SseConsoleCloseoutStream {
    fn drop(&mut self) {
        let terminal = self
            .observed_terminal_frame
            .clone()
            .unwrap_or(V3SseConsoleStreamTerminal::Dropped);
        self.emit_terminal(terminal);
    }
}

fn wrap_v3_relay_sse_closeout_stream(
    stream: V3ResponsesRelayClientStream,
    closeout: impl FnOnce(V3SseConsoleStreamTerminal) + Send + 'static,
) -> V3ResponsesRelayClientStream {
    Box::pin(V3SseConsoleCloseoutStream {
        stream,
        closeout: Some(Box::new(closeout)),
        decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
        observed_terminal_frame: None,
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
                .expect("typed response");
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
    let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
    emit_v3_frame_error_console_line(server, endpoint, request_id, &frame);
    responses_direct_output_response(frame)
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
            "in:59842 out:822 cache=41984/59842(70.2%) total=60664"
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
            "in:59842 out:822 cache=41984/59842(70.2%) total=60664"
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
            "[5555] 🧭 [stopless] 00:00:00 request req activated (hook=reasoningStop callId=call_stopless_reasoning action=exec_command finishReason=stop transport=sse)",
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
        assert!(colored.contains("hook=reasoningStop"));
        assert!(colored.contains("callId=call_stopless_reasoning"));
    }

    #[tokio::test]
    async fn relay_sse_closeout_emits_complete_once_on_terminal_end() {
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
    async fn relay_sse_closeout_treats_requires_action_as_terminal_end() {
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
    async fn relay_sse_closeout_fails_when_provider_stream_ends_without_terminal() {
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
            vec![V3SseConsoleStreamTerminal::Failed(
                "provider SSE stream ended before response.completed".to_string()
            )]
        );
    }

    #[tokio::test]
    async fn relay_sse_closeout_emits_failure_on_response_failed_terminal() {
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
            vec![V3SseConsoleStreamTerminal::Failed(
                "upstream stream failed".to_string()
            )]
        );
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
    async fn relay_sse_closeout_treats_drop_after_terminal_frame_as_completed() {
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
            vec![V3SseConsoleStreamTerminal::Completed]
        );
    }
}
