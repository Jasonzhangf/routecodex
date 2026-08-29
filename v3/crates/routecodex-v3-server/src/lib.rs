mod compaction_request;
mod console;
mod endpoint_handlers;
mod executors;
mod frame_builders;
mod live_snapshot;
mod metadata_center;
mod models_catalog;
mod request_id;
mod responses_direct_server_outcome;
mod restart_closeout;
mod restart_handoff;
mod scope_metadata;
mod session_admission;
mod websocket;
mod webui_observability;
mod webui_observability_endpoints;

use compaction_request::classify_v3_request_purpose;
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
pub(crate) use metadata_center::*;
use request_id::{
    format_v3_tm, v3_request_id_clock_now, V3AllocatedRequestIdentity, V3RequestCounterState,
    V3RequestIdCounter,
};
pub use restart_handoff::*;
pub(crate) use routecodex_v3_runtime::V3RequestPurpose;
pub(crate) use scope_metadata::*;
use websocket::{responses_websocket_endpoint, responses_websocket_session};
use webui_observability::V3WebuiObservability;

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
    V3AdminWebuiManifest, V3Config05ManifestPublished, V3DebugManifest,
    V3EntryProtocolExecutionMode, V3ServerManifest,
};
use routecodex_v3_debug::{
    V3DebugBoundedTextCapture, V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig,
    V3DebugTraceScope, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_error::{
    is_v3_client_disconnect_source, project_v3_http_boundary_error,
    project_v3_post_commit_sse_source, project_v3_server_invalid_request,
    project_v3_server_runtime_failure, project_v3_server_websocket_error,
    raise_v3_debug_artifact_failure, raise_v3_runtime_observability_contract_failure,
    raise_v3_sse_client_disconnect, raise_v3_sse_provider_failure, raise_v3_sse_runtime_failure,
    V3Error01SourceRaised, V3HttpBoundaryErrorKind, V3ProviderFailureSessionScope,
};
use routecodex_v3_runtime::{
    build_v3_provider_global_probe_target, build_v3_server_03_http_request_raw,
    build_v3_server_03_http_request_raw_with_purpose,
    build_v3_server_03_http_request_raw_with_purpose_and_port,
    build_v3_server_03_http_request_raw_with_purpose_and_scope,
    execute_v3_anthropic_relay_dry_run_runtime_with_client_headers,
    execute_v3_anthropic_relay_runtime_with_default_transport,
    execute_v3_anthropic_relay_runtime_with_default_transport_and_client_headers,
    execute_v3_anthropic_relay_runtime_with_default_transport_client_headers_provider_health,
    execute_v3_foundation_pending_runtime, execute_v3_gemini_relay_runtime_with_default_transport,
    execute_v3_gemini_relay_runtime_with_default_transport_provider_health,
    execute_v3_openai_chat_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health,
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_execution_mode,
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
    plan_v3_responses_protocol_execution_with_provider_health, probe_v3_provider_global_target,
    project_v3_anthropic_relay_runtime_failure, project_v3_debug_failure,
    project_v3_gemini_relay_runtime_failure, project_v3_openai_chat_relay_runtime_failure,
    project_v3_protocol_execution_plan_failure,
    project_v3_responses_previous_response_owner_resolution_error,
    project_v3_responses_relay_runtime_failure, project_v3_virtual_router_dry_run,
    project_v3_virtual_router_status, register_responses_direct_hooks,
    resolve_v3_responses_previous_response_owner_execution_mode_at_req03,
    V3AnthropicRelayClientHeader, V3AnthropicRelayRuntimeInput, V3AnthropicRelayRuntimeOutput,
    V3ChatDirectCodec, V3ClientBody, V3ClientSseStream, V3CommittedClientSseStream,
    V3CommittedSseTerminal, V3Execution11ProtocolDecisionMode, V3FoundationRuntimeInput,
    V3FoundationRuntimeOutput, V3GeminiRelayClientBody, V3GeminiRelayRuntimeInput,
    V3GeminiRelayRuntimeOutput, V3HubExecutionMode, V3OpenAiChatClientStream,
    V3OpenAiChatCommittedStream, V3OpenAiChatRelayClientBody, V3OpenAiChatRelayRuntimeInput,
    V3OpenAiChatRelayRuntimeOutput, V3RelayProviderSnapshots, V3Resp15ClientPayload,
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
    hold_response_body_admission_permit, hold_response_body_request_activity_permit,
    V3ResponsesSessionAdmissionGate, V3ResponsesSessionAdmissionPermit,
    V3ResponsesSessionAdmissionScope, V3ServerRequestActivityGate,
};
use std::collections::{BTreeMap, BTreeSet};
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
    realtime_cooled_provider_keys: Arc<Mutex<BTreeMap<String, u64>>>,
    responses_session_admission: Arc<V3ResponsesSessionAdmissionGate>,
    request_activity_gate: Arc<V3ServerRequestActivityGate>,
    front_transport_broker: V3FrontTransportBroker,
    webui_observability: V3WebuiObservability,
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
    CommittedSse(V3CommittedClientSseStream),
}

impl fmt::Debug for V3Server16Body {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(value) => formatter.debug_tuple("Json").field(value).finish(),
            Self::Bytes(bytes) => formatter
                .debug_struct("Bytes")
                .field("byte_len", &bytes.len())
                .finish(),
            Self::Sse(_) => formatter.write_str("Sse(<runtime-client-stream>)"),
            Self::CommittedSse(_) => formatter.write_str("CommittedSse(<runtime-sealed-replay>)"),
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
    request_activity_gate: Arc<V3ServerRequestActivityGate>,
    front_transport_broker: V3FrontTransportBroker,
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
    pub fn front_transport_broker(&self) -> &V3FrontTransportBroker {
        &self.front_transport_broker
    }

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

    /// Stop accepting new listener work without waiting for active client
    /// bodies. Active bodies belong to Front/Transport handoff and must be
    /// checkpointed/reattached by the lifecycle owner; waiting here would
    /// deadlock restart on a provider stream that is already being replaced.
    pub async fn prepare_for_exec(mut self) -> Vec<V3RuntimeHandoffCheckpoint> {
        let checkpoints = self.front_transport_broker.freeze(Instant::now());
        // The current exec path does not transfer accepted client descriptors
        // or Hyper connection tasks. Close those transports before replacing
        // the process; otherwise the replacement can restore a lease with no
        // socket owner and the client waits forever.
        self.front_transport_broker.close_active_client_transports();
        if let Some(shutdown) = self.probe_shutdown.take() {
            let _ = shutdown.send(());
        }
        for listener in &mut self.listeners {
            if let Some(shutdown) = listener.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
        let _ = &self.request_activity_gate;
        checkpoints
    }

    pub fn restore_front_checkpoints(
        &self,
        checkpoints: &[V3RuntimeHandoffCheckpoint],
    ) -> Result<usize, String> {
        self.front_transport_broker
            .restore_checkpoints(checkpoints, Instant::now())
    }

    pub async fn shutdown_listener_ports(&mut self, ports: &BTreeSet<u16>) -> Vec<u16> {
        let mut released = Vec::new();
        for listener in &mut self.listeners {
            if listener.server_id == "admin_webui" {
                continue;
            }
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
    spawn_v3_server_aggregate_with_admin(manifest, None, None).await
}

pub async fn spawn_v3_server_aggregate_with_admin(
    manifest: V3Config05ManifestPublished,
    admin_webui: Option<V3AdminWebuiManifest>,
    admin_config_path: Option<std::path::PathBuf>,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    let sse_dump_enabled = v3_sse_dump_env_flag();
    let console_enabled = manifest.debug.log_console;
    let debug_manifest = manifest.debug.clone();
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
            && !manifest.debug.full_codex_sampling
            && !manifest.debug.codex_samples,
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
    if let Some(admin) = admin_webui.filter(|admin| admin.enabled) {
        let addr: SocketAddr = format!("{}:{}", admin.bind, admin.port)
            .parse()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let listener = TcpListener::bind(addr).await?;
        let bound_addr = listener.local_addr()?;
        bound.push((
            V3ServerManifest {
                id: "admin_webui".to_string(),
                enabled: true,
                bind: admin.bind,
                port: admin.port,
                routing_group: String::new(),
                endpoints: Vec::new(),
                features: BTreeMap::new(),
                execution: None,
                http_sse_keepalive_ms: 0,
                expose_models: Vec::new(),
            },
            listener,
            bound_addr,
        ));
    }

    let request_counter = Arc::new(Mutex::new(V3RequestIdCounter::new()));
    let request_activity_gate = Arc::new(V3ServerRequestActivityGate::default());
    // Generation zero is reserved for an uninitialized handoff carrier. A
    // listener may accept requests as soon as it binds, so the normal startup
    // broker must already carry a valid positive runtime generation.
    let front_transport_broker = V3FrontTransportBroker::new(1);
    let admin_config_path_for_router = admin_config_path.clone();
    let canonical_admin_config_path = admin_config_path.clone().or_else(|| {
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .map(routecodex_v3_config::default_v3_config_path)
    });
    let mut listeners = Vec::with_capacity(bound.len());
    for (server, listener, addr) in bound {
        let server_id = server.id.clone();
        let app = if server_id == "admin_webui" {
            let config_path = admin_config_path_for_router.clone().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "admin_webui requires a canonical config path",
                )
            })?;
            routecodex_v3_admin::router(routecodex_v3_admin::AppState::new(config_path))
        } else {
            let config_path = canonical_admin_config_path.as_ref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "observability requires HOME or an explicit canonical config path",
                )
            })?;
            let observability_store_path = routecodex_v3_config::v3_webui_observability_store_path(
                config_path,
                manifest.debug.log_file.as_deref(),
                server.port,
            );
            let webui_observability =
                V3WebuiObservability::load_persisted(&observability_store_path)
                    .map_err(std::io::Error::other)?;
            build_v3_listener_router(V3ListenerState {
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
                realtime_cooled_provider_keys: Arc::new(Mutex::new(BTreeMap::new())),
                responses_session_admission: Arc::new(V3ResponsesSessionAdmissionGate::default()),
                request_activity_gate: Arc::clone(&request_activity_gate),
                front_transport_broker: front_transport_broker.clone(),
                webui_observability,
            })
        };
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let connection_broker = front_transport_broker.clone();
        let app_for_serve = app.clone();
        tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, remote_addr)) = accepted else { break };
                        let connection_identity = connection_broker.allocate_connection_identity();
                        let service = app_for_serve.clone().into_service();
                        let request_connection_broker = connection_broker.clone();
                        tokio::spawn(async move {
                            if let Err(error) = serve_v3_front_http_connection(
                                stream,
                                remote_addr,
                                connection_identity,
                                request_connection_broker,
                                service,
                            ).await {
                                eprintln!("V3 Front HTTP connection failed: {error}");
                            }
                        });
                    }
                }
            }
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
        let startup_manifest = Arc::clone(&probe_manifest);
        let startup_now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as u64,
            Err(error) => {
                eprintln!("provider persistent startup probe clock failure: {error}");
                return;
            }
        };
        let startup_result = probe_health
            .run_due_global_subscription_probes(
                startup_now_ms,
                move |provider_id, auth_alias, model_id| {
                    let startup_manifest = Arc::clone(&startup_manifest);
                    async move {
                        let target = build_v3_provider_global_probe_target(
                            &startup_manifest,
                            &provider_id,
                            auth_alias.as_deref(),
                            model_id.as_deref(),
                        )?;
                        probe_v3_provider_global_target(target).await
                    }
                },
            )
            .await;
        // Probe health records each target result; aggregate probe errors are
        // not human console events.
        let _ = startup_result;
        let startup_key_manifest = Arc::clone(&probe_manifest);
        let startup_key_result = probe_health
            .run_due_provider_key_health_probes(
                startup_now_ms,
                false,
                move |provider_id, auth_alias, model_id| {
                    let startup_key_manifest = Arc::clone(&startup_key_manifest);
                    async move {
                        let target = build_v3_provider_global_probe_target(
                            &startup_key_manifest,
                            &provider_id,
                            Some(&auth_alias),
                            Some(&model_id),
                        )?;
                        probe_v3_provider_global_target(target).await
                    }
                },
            )
            .await;
        let _ = startup_key_result;
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
                    let _ = result;
                    let key_manifest_for_probe = Arc::clone(&probe_manifest);
                    let key_result = probe_health.run_due_provider_key_health_probes(
                        now_ms,
                        false,
                        move |provider_id, auth_alias, model_id| {
                            let key_manifest_for_probe = Arc::clone(&key_manifest_for_probe);
                            async move {
                                let target = build_v3_provider_global_probe_target(
                                    &key_manifest_for_probe,
                                    &provider_id,
                                    Some(&auth_alias),
                                    Some(&model_id),
                                )?;
                                probe_v3_provider_global_target(target).await
                            }
                        },
                    ).await;
                    let _ = key_result;
                }
            }
        }
    });
    Ok(V3ServerAggregateHandle {
        listeners,
        probe_shutdown: Some(probe_shutdown),
        request_activity_gate,
        front_transport_broker,
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
        .route("/v1/responses/compact", post(pending_endpoint))
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
        .route(
            "/_routecodex/health/cooldown-pool",
            get(webui_observability_endpoints::cooldown_pool).post(
                webui_observability_endpoints::remove_cooldown,
            ),
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

async fn admit_v3_responses_session_after_json_parse(
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
    let permit = state
        .responses_session_admission
        .admit(V3ResponsesSessionAdmissionScope {
            endpoint: path.to_string(),
            session_id,
            conversation_id,
        })
        .await;
    Ok(permit)
}

async fn pending_endpoint(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let front_connection_identity = request
        .extensions()
        .get::<V3FrontConnectionIdentity>()
        .copied();
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
    let request_purpose = match classify_v3_request_purpose(&path, &request_headers) {
        Ok(request_purpose) => request_purpose,
        Err(message) => {
            let request_id = match allocate_v3_console_request_id(&state, &path, None) {
                Ok(request_id) => request_id,
                Err(response) => return *response,
            };
            return error_output_response_for_server(
                &state.server,
                &path,
                &request_id,
                project_http_input_error(V3HttpBoundaryErrorKind::MalformedJson, message),
            );
        }
    };
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
                    entry_protocol: &entry_protocol,
                    session_id: None,
                    status: frame.status,
                    error_chain: &frame.error_chain,
                    body: match &frame.body {
                        V3Server16Body::Json(value) => Some(value),
                        V3Server16Body::Bytes(_)
                        | V3Server16Body::Sse(_)
                        | V3Server16Body::CommittedSse(_) => None,
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
                Some(Duration::from_millis(state.server.http_sse_keepalive_ms)),
            );
        }
    };
    let admission_permit = if entry_protocol == "responses" {
        match admit_v3_responses_session_after_json_parse(&state, &path, &request_headers, &payload)
            .await
        {
            Ok(permit) => permit,
            Err(response) => return response,
        }
    } else {
        None
    };
    let request_activity_permit = state.request_activity_gate.admit();
    let response = pending_endpoint_after_responses_admission(
        state,
        front_connection_identity,
        request_headers,
        method,
        path,
        started_at,
        entry_protocol,
        execution_mode,
        pending_owner_symbol,
        request_purpose,
        payload,
    )
    .await;
    let response = hold_response_body_request_activity_permit(response, request_activity_permit);
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
    entry_protocol: &'input str,
    session_id: Option<&'input str>,
    status: u16,
    error_chain: &'input [&'static str],
    body: Option<&'input Value>,
    project_path: Option<&'input str>,
}

/// relay 分支共享：error_chain 存在时做 console 投影（4 个 relay 分支同构样板收敛）。
fn emit_relay_error_chain_if_any(
    state: &Arc<V3ListenerState>,
    trace_scope: &V3DebugTraceScope,
    entry_protocol: &str,
    path: &str,
    request_id: &str,
    session_id: Option<&str>,
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
            entry_protocol,
            session_id,
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
    if let Err(error) = webui_observability::record_v3_webui_error_projection(
        &state.webui_observability,
        state.server.port,
        input.request_id,
        input.endpoint,
        input.entry_protocol,
        input.project_path,
        input.session_id,
        input.status,
        input.body,
    ) {
        let line = format_v3_console_timed_content(
            "[webui-observability]",
            &format!("req={} error={}", input.request_id, error),
        );
        append_v3_human_console_line(state, &line);
    }
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

fn v3_request_wants_sse(headers: &HeaderMap, payload: &Value) -> bool {
    payload.get("stream").and_then(Value::as_bool) == Some(true) || request_accepts_sse(headers)
}

fn v3_entry_request_wants_sse(headers: &HeaderMap, payload: &Value) -> bool {
    v3_request_wants_sse(headers, payload)
}

fn build_v3_provider_failure_session_scope_for_request(
    server: &V3ServerManifest,
    headers: &HeaderMap,
    payload: &Value,
) -> Option<V3ProviderFailureSessionScope> {
    provider_failure_session_id_from_request(headers, payload)
        .ok()
        .flatten()
        .and_then(|session_id| {
            V3ProviderFailureSessionScope::new(&server.id, &server.routing_group, &session_id).ok()
        })
}

/// Get the provider-failure control scope without changing the client request.
///
/// A client session header or registered body session is optional request data.
/// It is useful when present, but it is not a prerequisite for an ordinary
/// request. Requests without one use their already allocated internal request
/// id as a request-local control-scope key.
fn get_failure_session_scope(
    server: &V3ServerManifest,
    headers: &HeaderMap,
    payload: &Value,
    _entry_protocol: &str,
    request_id: &str,
) -> Result<V3ProviderFailureSessionScope, String> {
    if let Some(scope) =
        build_v3_provider_failure_session_scope_for_request(server, headers, payload)
    {
        return Ok(scope);
    }
    V3ProviderFailureSessionScope::new(
        &server.id,
        &server.routing_group,
        format!("request-local-{request_id}"),
    )
}

fn provider_failure_session_id_from_request(
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Option<String>, String> {
    let header_session_id = responses_control_scope_headers(headers)
        .map(|(session_id, _conversation_id)| session_id)?;
    if header_session_id.is_some() {
        return Ok(header_session_id);
    }
    let body_session_id = read_first_scope_value(Some(payload), BODY_SESSION_PATHS);
    if body_session_id.is_some() {
        return Ok(body_session_id);
    }
    let turn_metadata = payload
        .get("client_metadata")
        .and_then(|metadata| metadata.get("x-codex-turn-metadata"))
        .and_then(Value::as_str)
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| {
            format!("client_metadata.x-codex-turn-metadata is not valid JSON: {error}")
        })?;
    Ok(read_first_scope_value(
        turn_metadata.as_ref(),
        TURN_METADATA_SESSION_PATHS,
    ))
}

#[cfg(test)]
mod tests;
