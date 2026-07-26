use axum::body::{to_bytes, Body};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{
    header::{CONTENT_LENGTH, CONTENT_TYPE},
    HeaderMap, HeaderValue, Response, StatusCode,
};
use axum::routing::{get, post};
use axum::Router;
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
    project_v3_responses_relay_runtime_failure, register_responses_direct_hooks,
    resolve_v3_responses_previous_response_owner_execution_mode_at_req03,
    V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput, V3ClientBody, V3ClientSseStream,
    V3Execution11ProtocolDecisionMode, V3FoundationRuntimeOutput, V3GeminiRelayClientBody,
    V3GeminiRelayRuntimeInput, V3GeminiRelayRuntimeOutput, V3LiveSnapResponsesTransport,
    V3OpenAiChatRelayClientBody, V3OpenAiChatRelayRuntimeInput, V3OpenAiChatRelayRuntimeOutput,
    V3Resp15ClientPayload, V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
    V3ResponsesDirectDryRunExecutionEnv, V3ResponsesDirectExecutionEnv,
    V3ResponsesDirectRuntimeSharedState, V3ResponsesProtocolExecutionPlan,
    V3ResponsesRelayClientBody, V3ResponsesRelayClientStream, V3ResponsesRelayDefaultTransport,
    V3ResponsesRelayDryRunExecutionEnv, V3ResponsesRelayExecutionEnv, V3ResponsesRelayHealthSource,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayLocalStoplessControlInput, V3ResponsesRelayProviderHealthHandle,
    V3ResponsesRelayProviderSnapshotCapture, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayRuntimeOutput, V3ResponsesRelayStoplessControlState, V3ResponsesTransport,
    V3RuntimeObservability, V3RuntimeProviderFailureObservation, V3RuntimeStreamObservation,
    V3RuntimeUsageSummary,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_02_from_fields,
    build_v3_sse_transport_in_03_from_v3_sse_transport_in_02,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03, SseField,
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

mod websocket;
use websocket::*;

mod endpoints;
use endpoints::*;

mod direct_frame;
mod error_projection;
mod models_catalog;
use models_catalog::*;
mod relay_frame;
use relay_frame::*;
mod continuation_scope;
use continuation_scope::*;
pub use direct_frame::build_v3_server_16_http_frame_from_v3_resp_15;
use direct_frame::{
    execute_responses_direct_server_frame,
    project_v3_responses_direct_stream_error_frame_if_requested, responses_direct_output_response,
    responses_direct_output_response_with_console,
};
pub use error_projection::{
    build_v3_server_16_http_frame_from_v3_error_06,
    build_v3_server_16_http_frame_from_v3_foundation_output,
};
use error_projection::{
    error_output_response_for_responses_request_with_project_path,
    error_output_response_for_server, error_output_response_for_server_with_project_path,
    insert_v3_projection_header, project_http_input_error,
    project_v3_responses_error_frame_for_request_if_sse, record_and_emit_v3_error_projection,
    V3ErrorProjectionConsoleInput,
};

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
