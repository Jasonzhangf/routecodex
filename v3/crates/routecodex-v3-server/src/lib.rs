mod active_key_control;
pub use active_key_control::{V3ActiveKeyControlExecHandoff, V3ActiveKeyControlStartup};
mod aggregate_probe_lifecycle;
mod client_sse_transport;
mod client_transport_observation;
mod compaction_request;
mod console;
mod debug_runtime_degradation;
mod endpoint_handlers;
mod executors;
mod frame_builders;
mod listener_accept;
mod live_snapshot;
mod live_snapshot_projections;
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
    allocate_v3_console_request_id, merge_v3_direct_handoff_provider_failure_events,
    merge_v3_protocol_plan_trace, merge_v3_relay_handoff_provider_failure_events_into_direct_frame,
    next_v3_console_request_identity, pending_endpoint_after_json_parse,
    prepend_v3_protocol_plan_trace_to_responses_relay_output,
    prepend_v3_relay_handoff_trace_to_direct_frame,
};
pub use executors::*;
pub(crate) use frame_builders::*;
pub(crate) use live_snapshot::*;
pub(crate) use live_snapshot_projections::*;
pub(crate) use metadata_center::*;
use request_id::{format_v3_tm, V3AllocatedRequestIdentity, V3RequestIdCounter};
pub use restart_handoff::*;
pub(crate) use routecodex_v3_runtime::V3RequestPurpose;
pub(crate) use scope_metadata::*;
use websocket::responses_websocket_endpoint;
#[cfg(test)]
pub(crate) use websocket::{
    send_responses_websocket_error_sdk_result, take_responses_websocket_sdk_fault_diagnostics,
};
use webui_observability::V3WebuiObservability;

use axum::body::{to_bytes, Body};
use axum::extract::{
    ws::{Message, WebSocket},
    ConnectInfo, Request, State,
};
use axum::http::{
    header::{CONTENT_LENGTH, CONTENT_TYPE},
    HeaderMap, Response,
};
use axum::routing::{get, post};
use axum::Router;
use client_sse_transport::{accept_v3_client_sse_transport, V3ClientDisconnectSlot};
use debug_runtime_degradation::build_v3_debug_runtime_degrading_optional_log_sink;
use futures_util::stream;
#[cfg(test)]
use futures_util::StreamExt;
use libc::EINTR;
use listener_accept::{run_v3_listener_accept_loop, V3ListenerAcceptState};
use responses_direct_server_outcome::{
    execute_responses_direct_server_outcome, V3ResponsesDirectServerOutcome,
};
use routecodex_v3_config::{
    resolve_routecodex_package_version_from_executable, V3AdminWebuiManifest,
    V3Config05ManifestPublished, V3DebugManifest, V3EntryProtocolExecutionMode, V3ServerManifest,
};
use routecodex_v3_debug::{
    V3DebugBoundedTextCapture, V3DebugError, V3DebugRuntime, V3DebugRuntimeConfig,
    V3DebugTraceScope, V3DryRunFixture, V3RedactionPolicy,
};
use routecodex_v3_error::{
    V3Error01SourceRaised, V3ErrorSourceKind, V3HttpBoundaryErrorKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw_with_purpose_and_scope,
    execute_v3_anthropic_relay_dry_run_runtime_with_client_headers,
    execute_v3_anthropic_relay_response_dry_run_runtime,
    execute_v3_anthropic_relay_runtime_with_default_transport,
    execute_v3_anthropic_relay_runtime_with_default_transport_and_client_headers,
    execute_v3_foundation_pending_runtime, execute_v3_gemini_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport,
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_handoff,
    execute_v3_responses_direct_dry_run_runtime,
    execute_v3_responses_direct_dry_run_runtime_with_client_identity,
    execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug,
    execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target,
    execute_v3_responses_relay_dry_run_orchestration_with_client_identity,
    execute_v3_responses_relay_runtime_with_default_transport,
    execute_v3_responses_relay_runtime_with_default_transport_health,
    foundation_output_from_error_sdk_result, plan_v3_responses_protocol_execution_with_recovery,
    project_v3_anthropic_relay_runtime_failure, project_v3_debug_failure,
    project_v3_gemini_relay_runtime_failure, project_v3_http_boundary_error_via_sdk,
    project_v3_openai_chat_relay_runtime_failure, project_v3_protocol_execution_plan_failure,
    project_v3_responses_relay_runtime_failure, project_v3_server_boundary_error_via_sdk,
    project_v3_virtual_router_dry_run, project_v3_virtual_router_status,
    register_responses_direct_hooks, V3AnthropicRelayClientHeader, V3AnthropicRelayRuntimeInput,
    V3AnthropicRelayRuntimeOutput, V3ChatDirectCodec, V3ClientBody, V3ClientSseStream,
    V3CommittedClientSseStream, V3CommittedSseTerminal, V3Execution11ProtocolDecisionMode,
    V3FoundationRuntimeInput, V3FoundationRuntimeOutput, V3GeminiRelayRuntimeInput,
    V3GeminiRelayRuntimeOutput, V3OpenAiChatRelayClientBody, V3OpenAiChatRelayRuntimeInput,
    V3OpenAiChatRelayRuntimeOutput, V3ProviderHealthListenerScope, V3RelayProviderSnapshots,
    V3RequestExecutionControl, V3Resp15ClientPayload, V3ResponsesDirectRuntimeSharedState,
    V3ResponsesProtocolExecutionPlan, V3ResponsesRelayClientBody, V3ResponsesRelayClientStream,
    V3ResponsesRelayDryRunOutcome, V3ResponsesRelayProviderHealthHandle,
    V3ResponsesRelayProviderSnapshotCapture, V3ResponsesRelayRuntimeError,
    V3ResponsesRelayRuntimeInput, V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeSeeds,
    V3RuntimeObservability, V3RuntimeObservabilityAccumulator, V3RuntimeProviderFailureEventSink,
    V3RuntimeProviderFailureObservation, V3RuntimeRouteSelectionEventSink,
    V3RuntimeStreamObservation, V3RuntimeTimingSummary, V3RuntimeUsageSummary,
    V3_RESPONSES_CLIENT_IDENTITY_HEADER_NAMES,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, build_v3_sse_transport_out_04_keepalive_comment,
    SseField, SseIncrementalDecoder, SseTransportLimits,
};
use routecodex_v3_target::{
    V3ActiveKeyIdentity, V3ActiveKeyScope, V3ActiveKeySelectionState, V3TargetInterpreter,
};
use serde::Deserialize;
use serde_json::{json, Value};
use session_admission::{
    hold_response_body_request_activity_permit, V3ServerMaintenanceGuard,
    V3ServerRequestActivityGate,
};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt;
use std::future::Future;
use std::io::{self, Write as _};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// feature_id: v3.codex_sample_retention_snap_scope
// sample persistence is owned solely by routecodex-v3-debug::V3CodexSampleStore.
pub(crate) fn v3_io_error_is_eintr(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Interrupted || error.raw_os_error() == Some(EINTR)
}

async fn bind_v3_tcp_listener_retry_eintr<F, Fut>(mut bind: F) -> io::Result<TcpListener>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<TcpListener>>,
{
    loop {
        match bind().await {
            Ok(listener) => return Ok(listener),
            // Restart inherits the foreground process signal environment, so bind
            // may be interrupted while the replacement process is starting.
            Err(error) if v3_io_error_is_eintr(&error) => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
type V3ResponsesHandoffObserver = dyn Fn(
        &routecodex_v3_target::V3Target10ConcreteProviderSelected,
        V3EntryProtocolExecutionMode,
        &V3ActiveKeySelectionState,
    ) + Send
    + Sync;

#[cfg(test)]
#[derive(Clone, Default)]
struct V3ResponsesHandoffObserverSlot(Arc<Mutex<Option<Arc<V3ResponsesHandoffObserver>>>>);

#[cfg(test)]
impl fmt::Debug for V3ResponsesHandoffObserverSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("V3ResponsesHandoffObserverSlot")
    }
}

#[cfg(test)]
impl V3ListenerState {
    fn observe_responses_handoff(
        &self,
        selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
        mode: V3EntryProtocolExecutionMode,
    ) {
        let observer = self.responses_handoff_observer.0.lock().unwrap().clone();
        if let Some(observer) = observer {
            observer(
                selected,
                mode,
                self.active_keys.as_deref().expect("listener active keys"),
            );
        }
    }
}

#[derive(Clone)]
pub(crate) struct V3ListenerState {
    server: V3ServerManifest,
    manifest_version: u16,
    manifest: Arc<V3Config05ManifestPublished>,
    debug: V3DebugRuntime,
    console_enabled: bool,
    sse_dump_enabled: bool,
    request_counter: Arc<Mutex<V3RequestIdCounter>>,
    codex_sample_store: Arc<routecodex_v3_debug::V3CodexSampleStore>,
    provider_health: Arc<V3ResponsesRelayProviderHealthHandle>,
    active_keys: Option<Arc<V3ActiveKeySelectionState>>,
    active_key_control_revoked: Arc<std::sync::RwLock<bool>>,
    #[cfg(test)]
    responses_handoff_observer: V3ResponsesHandoffObserverSlot,
    image_history: routecodex_v3_runtime::V3SuccessfulImageHistory,
    realtime_cooled_provider_keys: Arc<Mutex<BTreeMap<String, u64>>>,
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
    pub diagnostic_source: Option<routecodex_v3_error::V3Error01SourceRaised>,
    pub diagnostic_cause: Option<routecodex_v3_error::V3Error01SourceRaised>,
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
    accept_state: Arc<V3ListenerAcceptState>,
    active_key_control_revoked: Arc<std::sync::RwLock<bool>>,
}

impl V3ListenerHandle {
    fn revoke_active_key_controls(&self) {
        *self.active_key_control_revoked.write().unwrap() = true;
    }
}

#[derive(Debug)]
pub struct V3ServerAggregateHandle {
    pub listeners: Vec<V3ListenerHandle>,
    #[cfg(test)]
    responses_handoff_observer: V3ResponsesHandoffObserverSlot,
    probe_lifecycle: aggregate_probe_lifecycle::AggregateProbeLifecycle,
    request_activity_gate: Arc<V3ServerRequestActivityGate>,
    front_transport_broker: V3FrontTransportBroker,
    provider_health: Vec<Arc<V3ResponsesRelayProviderHealthHandle>>,
    observability_writers: Vec<V3WebuiObservability>,
    codex_sample_persist_worker: Option<routecodex_v3_debug::V3CodexSamplePersistHandle>,
    active_key_controls: Vec<ActiveKeyControlOwner>,
    active_key_control_startup_details: Vec<String>,
}

#[derive(Debug)]
struct ActiveKeyControlOwner {
    transport: Option<ActiveKeyControlTransport>,
    record_paths: routecodex_v3_config::V3ActiveKeyControlPaths,
    record: active_key_control::ActiveKeyControlEndpointRecord,
    record_pending: bool,
    record_live: bool,
}

#[derive(Debug)]
struct ActiveKeyControlTransport {
    task: tokio::task::JoinHandle<()>,
    shutdown: Option<oneshot::Sender<()>>,
    broker: V3FrontTransportBroker,
}

impl ActiveKeyControlTransport {
    fn close_transports_now(&mut self) {
        self.task.abort();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.broker.close_active_client_transports();
    }

    async fn close(&mut self) {
        self.close_transports_now();
        let _ = (&mut self.task).await;
    }
}

impl Drop for ActiveKeyControlTransport {
    fn drop(&mut self) {
        self.close_transports_now();
    }
}

impl ActiveKeyControlOwner {
    fn close_transports_now(&mut self) {
        self.record_live = false;
        if let Some(transport) = self.transport.as_mut() {
            transport.close_transports_now();
        }
    }

    async fn close_until(&mut self, deadline: tokio::time::Instant) -> io::Result<()> {
        if let Some(mut transport) = self.transport.take() {
            transport.close().await;
        }
        if self.record_pending {
            active_key_control::remove_owned_record_until(
                &self.record_paths,
                &self.record,
                deadline,
            )
            .await?;
            self.record_pending = false;
        }
        Ok(())
    }

    fn cleanup_failure(&self, error: io::Error) -> V3ActiveKeyControlCleanupFailure {
        V3ActiveKeyControlCleanupFailure {
            pending: self.record_pending,
            server_id: self.record.server_id.clone(),
            business_addr: self.record.business_addr,
            record_path: self.record_paths.record.clone(),
            error,
        }
    }
}

impl Drop for ActiveKeyControlOwner {
    fn drop(&mut self) {
        self.close_transports_now();
        if self.record_pending {
            if let Err(error) =
                active_key_control::try_remove_owned_record(&self.record_paths, &self.record)
            {
                eprintln!("{}", self.cleanup_failure(error));
            }
        }
    }
}

const ACTIVE_KEY_CONTROL_ACQUISITION_BUDGET: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub struct V3ActiveKeyControlCleanupFailure {
    pub pending: bool,
    pub server_id: String,
    pub business_addr: SocketAddr,
    pub record_path: PathBuf,
    pub error: io::Error,
}

impl std::fmt::Display for V3ActiveKeyControlCleanupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "V3 active-key control record cleanup failed for {} at {} ({}): {}",
            self.server_id,
            self.business_addr,
            self.record_path.display(),
            self.error
        )
    }
}

impl std::error::Error for V3ActiveKeyControlCleanupFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

#[derive(Debug, Default)]
pub struct V3ServerCloseReport {
    pub pending_controls: Option<V3ActiveKeyControlExecHandoff>,
    pub control_disposition_error: Option<io::Error>,
    pub codex_sample_persist_failures: Vec<routecodex_v3_debug::V3CodexSamplePersistFailure>,
    pub control_cleanup_failures: Vec<V3ActiveKeyControlCleanupFailure>,
}

impl V3ServerCloseReport {
    pub fn is_empty(&self) -> bool {
        self.codex_sample_persist_failures.is_empty()
            && self.control_cleanup_failures.is_empty()
            && self.control_disposition_error.is_none()
    }
}

impl std::fmt::Display for V3ServerCloseReport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut details = Vec::new();
        if let Some(error) = &self.control_disposition_error {
            details.push(format!("active-key control disposition failed: {error}"));
        }
        if !self.codex_sample_persist_failures.is_empty() {
            details.push(format!(
                "codex sample persistence shutdown failed: {}",
                self.codex_sample_persist_failures
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        details.extend(
            self.control_cleanup_failures
                .iter()
                .map(ToString::to_string),
        );
        formatter.write_str(&details.join("; "))
    }
}

#[derive(Debug, Default)]
pub struct V3ListenerPortCloseReport {
    pub released_ports: Vec<u16>,
    pub control_cleanup_failures: Vec<V3ActiveKeyControlCleanupFailure>,
}

#[derive(Debug)]
pub struct V3ServerExecPreparation {
    pub front_checkpoints: Vec<V3RuntimeHandoffCheckpoint>,
    pub codex_sample_persist_failures: Vec<routecodex_v3_debug::V3CodexSamplePersistFailure>,
    pub control_cleanup_failures: Vec<V3ActiveKeyControlCleanupFailure>,
    pub control_disposition_error: Option<io::Error>,
    pub active_key_control_handoff: Option<V3ActiveKeyControlExecHandoff>,
    _codex_sample_exec_guard: Option<routecodex_v3_debug::V3CodexSampleExecGuard>,
    _maintenance_guard: Option<V3ServerMaintenanceGuard>,
    _probe_quiescence_guard: Option<aggregate_probe_lifecycle::ProbeQuiescenceGuard>,
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
    pub async fn prepare_exec_attempt(&self) -> Result<V3ServerExecPreparation, String> {
        let maintenance_guard = self.request_activity_gate.pause_dispatch().await;
        let probe_quiescence_guard = self.probe_lifecycle.quiesce(maintenance_guard).await?;
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            for provider_health in &self.provider_health {
                provider_health
                    .store()
                    .flush_persistence_for_exec()
                    .await
                    .map_err(|error| {
                        format!("provider health persistence preparation failed: {error}")
                    })?;
            }
            for observability in &self.observability_writers {
                observability
                    .flush_persistence_for_exec()
                    .await
                    .map_err(|error| {
                        format!("observability persistence preparation failed: {error}")
                    })?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "runtime persistence preparation timed out; owner retained".to_string())??;
        let codex_sample_exec_guard = match self.codex_sample_persist_worker.as_ref() {
            Some(worker) => match tokio::time::timeout(
                std::time::Duration::from_secs(1),
                worker.quiesce_for_exec(),
            )
            .await
            {
                Ok(Ok(guard)) => Some(guard),
                Ok(Err(error)) => {
                    return Err(format!(
                        "codex sample persistence preparation failed: {error}"
                    ))
                }
                Err(_) => {
                    return Err(
                        "codex sample persistence preparation timed out; worker retained".into(),
                    )
                }
            },
            None => None,
        };
        let codex_sample_persist_failures = codex_sample_exec_guard
            .as_ref()
            .map(|guard| guard.persist_failures())
            .unwrap_or_default();
        Ok(V3ServerExecPreparation {
            front_checkpoints: self.front_transport_broker.freeze(Instant::now()),
            codex_sample_persist_failures,
            control_cleanup_failures: Vec::new(),
            control_disposition_error: None,
            active_key_control_handoff: self.exact_active_key_custody(),
            _codex_sample_exec_guard: codex_sample_exec_guard,
            _maintenance_guard: None,
            _probe_quiescence_guard: Some(probe_quiescence_guard),
        })
    }

    pub fn front_transport_broker(&self) -> &V3FrontTransportBroker {
        &self.front_transport_broker
    }

    pub fn active_key_control_startup_details(&self) -> &[String] {
        &self.active_key_control_startup_details
    }

    #[doc(hidden)]
    pub async fn wait_for_codex_sample_persistence(&self) -> Result<(), String> {
        self.codex_sample_persist_worker
            .as_ref()
            .ok_or_else(|| "codex sample persist worker is not running".to_string())?
            .wait_until_idle()
            .await
    }

    pub async fn shutdown(mut self) -> V3ServerCloseReport {
        let mut report = self.close_active_key_controls().await;
        self.probe_lifecycle.terminate();
        self.probe_lifecycle.join().await;
        let mut persistence_failures = self.close_runtime_persistence().await;
        let codex_sample_persist_failures = match self.codex_sample_persist_worker.take() {
            Some(mut worker) => worker.shutdown().await,
            None => Vec::new(),
        };
        for listener in &mut self.listeners {
            if let Some(shutdown) = listener.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
        persistence_failures.extend(codex_sample_persist_failures);
        report.codex_sample_persist_failures = persistence_failures;
        report
    }

    /// Stop new business dispatch, wait for accepted requests to finish, then
    /// close the remaining idle transports before exec replacement.
    pub async fn prepare_for_exec(mut self) -> V3ServerExecPreparation {
        for listener in &self.listeners {
            listener.revoke_active_key_controls();
        }
        self.probe_lifecycle.terminate();
        let maintenance_guard = self.request_activity_gate.begin_maintenance().await;
        self.probe_lifecycle.join().await;
        for listener in &mut self.listeners {
            if let Some(shutdown) = listener.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
        let close = self.close_active_key_controls().await;
        let checkpoints = self.front_transport_broker.freeze(Instant::now());
        // The current exec path does not transfer accepted client descriptors
        // or Hyper connection tasks. Close those transports before replacing
        // the process; otherwise the replacement can restore a lease with no
        // socket owner and the client waits forever.
        self.front_transport_broker.close_active_client_transports();
        let mut codex_sample_persist_failures = self.close_runtime_persistence().await;
        codex_sample_persist_failures.extend(match self.codex_sample_persist_worker.take() {
            Some(mut worker) => worker.shutdown().await,
            None => Vec::new(),
        });
        V3ServerExecPreparation {
            front_checkpoints: checkpoints,
            codex_sample_persist_failures,
            control_cleanup_failures: close.control_cleanup_failures,
            control_disposition_error: close.control_disposition_error,
            active_key_control_handoff: close.pending_controls,
            _codex_sample_exec_guard: None,
            _maintenance_guard: Some(maintenance_guard),
            _probe_quiescence_guard: None,
        }
    }

    async fn close_runtime_persistence(
        &self,
    ) -> Vec<routecodex_v3_debug::V3CodexSamplePersistFailure> {
        let mut failures = Vec::new();
        for provider_health in &self.provider_health {
            let provider_health = provider_health.clone();
            let result =
                tokio::task::spawn_blocking(move || provider_health.flush_persistence()).await;
            if let Err(error) = result.unwrap_or_else(|error| Err(error.to_string())) {
                failures.push(routecodex_v3_debug::V3CodexSamplePersistFailure {
                    request_id: "runtime-closeout".into(),
                    file_name: "provider-health".into(),
                    reason: error,
                });
            }
        }
        for observability in &self.observability_writers {
            if let Err(error) = observability.close_persistence_async().await {
                failures.push(routecodex_v3_debug::V3CodexSamplePersistFailure {
                    request_id: "runtime-closeout".into(),
                    file_name: "observability".into(),
                    reason: error,
                });
            }
        }
        failures
    }

    pub async fn close_active_key_controls(&mut self) -> V3ServerCloseReport {
        for listener in &self.listeners {
            listener.revoke_active_key_controls();
        }
        let mut custody = self.exact_active_key_custody().unwrap_or_default();
        for owner in &mut self.active_key_controls {
            owner.close_transports_now();
        }
        for owner in &mut self.active_key_controls {
            if let Some(mut transport) = owner.transport.take() {
                transport.close().await;
            }
            owner.record_pending = false;
        }
        self.active_key_controls.clear();
        let mut report = V3ServerCloseReport::default();
        match custody.retire_failed_startup().await {
            Ok(failures) => report.control_cleanup_failures = failures,
            Err(error) => report.control_disposition_error = Some(error),
        }
        report.pending_controls = (!custody.is_empty()).then_some(custody);
        report
    }

    pub fn restore_front_checkpoints(
        &self,
        checkpoints: &[V3RuntimeHandoffCheckpoint],
    ) -> Result<usize, String> {
        self.front_transport_broker
            .restore_checkpoints(checkpoints, Instant::now())
    }

    pub async fn shutdown_listener_ports(
        &mut self,
        ports: &BTreeSet<u16>,
    ) -> V3ListenerPortCloseReport {
        let mut report = V3ListenerPortCloseReport::default();
        let mut selected = BTreeSet::new();
        for listener in self.listeners.iter_mut().filter(|listener| {
            listener.server_id != "admin_webui" && ports.contains(&listener.addr.port())
        }) {
            listener.revoke_active_key_controls();
            if let Some(shutdown) = listener.shutdown.take() {
                let _ = shutdown.send(());
            }
            selected.insert((listener.server_id.as_str(), listener.addr));
            report.released_ports.push(listener.addr.port());
        }
        let deadline = tokio::time::Instant::now() + ACTIVE_KEY_CONTROL_ACQUISITION_BUDGET;
        let matches_listener = |owner: &ActiveKeyControlOwner| {
            selected.contains(&(owner.record.server_id.as_str(), owner.record.business_addr))
                // A pending inherited owner can outlive its listener declaration.
                || (!owner.record_live && ports.contains(&owner.record.business_addr.port()))
        };
        for owner in self
            .active_key_controls
            .iter_mut()
            .filter(|owner| matches_listener(owner))
        {
            owner.close_transports_now();
        }
        for owner in self
            .active_key_controls
            .iter_mut()
            .filter(|owner| matches_listener(owner))
        {
            if let Err(error) = owner.close_until(deadline).await {
                report
                    .control_cleanup_failures
                    .push(owner.cleanup_failure(error));
            }
        }
        self.active_key_controls
            .retain(|owner| owner.record_pending);
        report
    }

    pub fn retained_active_key_cleanup_ports(&self) -> impl Iterator<Item = u16> + '_ {
        self.active_key_controls
            .iter()
            .filter(|owner| owner.record_pending && !owner.record_live)
            .map(|owner| owner.record.business_addr.port())
    }

    pub fn exact_active_key_custody(&self) -> Option<V3ActiveKeyControlExecHandoff> {
        V3ActiveKeyControlExecHandoff::capture(&self.active_key_controls)
    }

    pub fn has_active_listener(&self) -> bool {
        self.listeners
            .iter()
            .any(|listener| listener.shutdown.is_some())
    }

    pub fn listener_release_is_complete(&self) -> bool {
        !self.has_active_listener() && self.active_key_controls.is_empty()
    }

    /// Total `accept()` failures observed by the listener tasks.
    ///
    /// A listener keeps its port across a transient accept failure, so this
    /// counter is the record that the failure happened instead of being silent.
    pub fn listener_accept_failure_count(&self) -> u64 {
        self.listeners
            .iter()
            .map(|listener| listener.accept_state.accept_failures())
            .sum()
    }

    /// The last `accept()` failure observed by a listener task, if any.
    pub fn listener_last_accept_error(&self) -> Option<String> {
        self.listeners
            .iter()
            .filter_map(|listener| listener.accept_state.last_accept_error())
            .next_back()
    }
}

impl Drop for V3ServerAggregateHandle {
    fn drop(&mut self) {
        self.probe_lifecycle.terminate();
        if self
            .listeners
            .iter()
            .any(|listener| listener.shutdown.is_some())
        {
            for listener in &mut self.listeners {
                listener.revoke_active_key_controls();
                if let Some(shutdown) = listener.shutdown.take() {
                    let _ = shutdown.send(());
                }
            }
        }
        self.active_key_controls.clear();
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
    spawn_v3_server_aggregate_with_admin_and_hooks_sidecar_socket(
        manifest,
        admin_webui,
        admin_config_path,
        None,
    )
    .await
}

pub async fn spawn_v3_server_aggregate_with_admin_and_hooks_sidecar_socket(
    manifest: V3Config05ManifestPublished,
    admin_webui: Option<V3AdminWebuiManifest>,
    admin_config_path: Option<std::path::PathBuf>,
    hooks_sidecar_socket: Option<PathBuf>,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    spawn_v3_server_aggregate_for_managed_startup(
        manifest,
        admin_webui,
        admin_config_path,
        hooks_sidecar_socket,
        None,
    )
    .await
}

/// Start the explicitly verified successor supplied by managed Lifecycle.
pub async fn spawn_v3_server_aggregate_for_managed_startup(
    manifest: V3Config05ManifestPublished,
    admin_webui: Option<V3AdminWebuiManifest>,
    admin_config_path: Option<PathBuf>,
    hooks_sidecar_socket: Option<PathBuf>,
    active_key_startup: Option<&V3ActiveKeyControlStartup>,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    spawn_v3_server_aggregate_with_health_dependencies(
        manifest,
        admin_webui,
        admin_config_path,
        hooks_sidecar_socket,
        None,
        active_key_startup,
    )
    .await
}

pub async fn spawn_v3_server_aggregate_with_health_observation_clock(
    manifest: V3Config05ManifestPublished,
    clock: Arc<dyn routecodex_v3_runtime::V3ProviderHealthObservationClock>,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    spawn_v3_server_aggregate_with_health_dependencies(
        manifest,
        None,
        None,
        None,
        Some(clock),
        None,
    )
    .await
}

async fn spawn_v3_server_aggregate_with_health_dependencies(
    manifest: V3Config05ManifestPublished,
    admin_webui: Option<V3AdminWebuiManifest>,
    admin_config_path: Option<std::path::PathBuf>,
    _hooks_sidecar_socket: Option<PathBuf>,
    observation_clock: Option<Arc<dyn routecodex_v3_runtime::V3ProviderHealthObservationClock>>,
    active_key_startup: Option<&V3ActiveKeyControlStartup>,
) -> Result<V3ServerAggregateHandle, std::io::Error> {
    let mut inherited = active_key_startup
        .map(V3ActiveKeyControlStartup::inherited_owners)
        .transpose()?
        .unwrap_or_default();
    #[cfg(test)]
    let mut control_storage_observer = active_key_control::take_storage_boundary_observer();
    let sse_dump_enabled = v3_sse_dump_env_flag();
    let console_enabled = manifest.debug.log_console;
    let debug_manifest = manifest.debug.clone();
    let manifest = Arc::new(manifest);
    let preflight = build_v3_server_startup_01_listener_set_from_config_05(&manifest);
    let debug = build_v3_debug_runtime_degrading_optional_log_sink(&debug_manifest)?;
    // 独立的 stage-3 投影丢弃日志 wiring：启动时确保父目录与 append-only 文件
    // 就位。丢弃证据刻意与 debug 日志物理分离，不写入 debug runtime。
    if let Some(projection_drop_log_file) = debug_manifest.projection_drop_log_file.as_deref() {
        if let Err(error) =
            routecodex_v3_runtime::projection_drop_log::ensure_v3_projection_drop_log_file(
                projection_drop_log_file,
            )
        {
            // 投影丢弃证据是 Debug 观测，不是业务真相：路径不可写时记录原因并
            // 继续，让声明的 listener 能力保持可用。
            eprintln!(
                "V3 projection drop log {projection_drop_log_file} unavailable: {error}; continuing without startup preparation"
            );
        }
    }
    let codex_sample_store = Arc::new(routecodex_v3_debug::V3CodexSampleStore::new(
        manifest.debug.codex_samples,
        routecodex_v3_debug::V3_CODEX_SAMPLE_REQUEST_RETENTION,
        routecodex_v3_config::internal::v3_error_samples_only()
            && !manifest.debug.full_codex_sampling
            && !manifest.debug.codex_samples,
    ));
    for server in &preflight.listeners {
        // Retention tolerates per-entry housekeeping failures inside the Debug
        // owner. The one contract-bound retention failure is the process-shared
        // sample lock, which must stay an explicit startup error: uncoordinated
        // retention would prune a tree another process is writing.
        codex_sample_store
            .enforce_listener_retention(server.port)
            .map_err(std::io::Error::other)?;
    }
    let admin_config_path_for_router = admin_config_path.clone();
    let mut bound = Vec::with_capacity(preflight.listeners.len());
    for server in preflight.listeners {
        let addr = format!("{}:{}", server.bind, server.port)
            .parse::<SocketAddr>()
            .or_else(|_| {
                server
                    .bind
                    .parse()
                    .map(|ip| SocketAddr::new(ip, server.port))
            })
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let listener = bind_v3_tcp_listener_retry_eintr(|| TcpListener::bind(addr)).await?;
        let bound_addr = listener.local_addr()?;
        bound.push((server, listener, bound_addr));
    }
    if let Some(admin) = admin_webui.filter(|admin| admin.enabled) {
        // The admin listener is optional. Its failure must not discard business
        // listeners that already bound, so it is isolated from the `?` path.
        let bound_admin = if admin_config_path_for_router.is_none() {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "admin_webui requires a canonical config path",
            ))
        } else {
            match format!("{}:{}", admin.bind, admin.port)
                .parse::<SocketAddr>()
                .or_else(|_| admin.bind.parse().map(|ip| SocketAddr::new(ip, admin.port)))
            {
                Ok(addr) => {
                    match bind_v3_tcp_listener_retry_eintr(|| TcpListener::bind(addr)).await {
                        Ok(listener) => listener
                            .local_addr()
                            .map(|bound_addr| (listener, bound_addr)),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, error)),
            }
        };
        match bound_admin {
            Ok((listener, bound_addr)) => bound.push((
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
                    provider_priority_schedule: Default::default(),
                },
                listener,
                bound_addr,
            )),
            Err(error) => eprintln!(
                "V3 optional admin_webui listener {}:{} unavailable: {error}; continuing with business listeners",
                admin.bind, admin.port
            ),
        }
    }

    let request_counter = Arc::new(Mutex::new(V3RequestIdCounter::new()));
    #[cfg(test)]
    let responses_handoff_observer = V3ResponsesHandoffObserverSlot::default();
    let request_activity_gate = Arc::new(V3ServerRequestActivityGate::default());
    // Generation zero is reserved for an uninitialized handoff carrier. A
    // listener may accept requests as soon as it binds, so the normal startup
    // broker must already carry a valid positive runtime generation.
    let front_transport_broker =
        V3FrontTransportBroker::new(1).with_client_observation(debug.clone());
    let canonical_admin_config_path = admin_config_path.clone().or_else(|| {
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .map(routecodex_v3_config::default_v3_config_path)
    });
    // Load required holds before spawning any listener task. Corrupt state
    // must never silently release keys, and legacy listeners do not load it.
    let mut active_key_states = std::collections::BTreeMap::new();
    for (server, _, addr) in &bound {
        if !manifest
            .route_groups
            .get(&server.routing_group)
            .is_some_and(|group| group.pools.values().any(|pool| pool.active_keys.is_some()))
        {
            continue;
        }
        let config_path = canonical_admin_config_path.as_ref().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "active keys require a canonical config path",
            )
        })?;
        let file_name = format!("active-keys-{}.json", addr.to_string().replace(':', "_"));
        let state = V3ActiveKeySelectionState::from_file(config_path.with_file_name(file_name))
            .map_err(std::io::Error::other)?;
        configure_listener_active_keys(&manifest, server, &state)?;
        active_key_states.insert(server.id.clone(), Arc::new(state));
    }
    let mut listeners = Vec::with_capacity(bound.len());
    let mut observability_writers = Vec::with_capacity(bound.len());
    let mut pending_listener_tasks = Vec::with_capacity(bound.len());
    let mut provider_health_handles = Vec::with_capacity(bound.len());
    let mut pending_active_key_controls = Vec::new();
    for (server, listener, addr) in bound {
        let server_id = server.id.clone();
        let active_key_control_revoked = Arc::new(std::sync::RwLock::new(false));
        let app = if server_id == "admin_webui" {
            let config_path = admin_config_path_for_router.clone().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "admin_webui requires a canonical config path",
                )
            })?;
            // The in-process admin listener is the shipping entry for the admin
            // surface: `[admin_webui] enabled = true` is part of the base config, and
            // the managed lifecycle spawns this aggregate directly instead of the
            // standalone `rccv3-admin` binary. The scheduled 定时巡检 tick loop
            // therefore has to start here — it is the only producer of scheduled
            // patrol runs in the default topology. `spawn_background` is idempotent
            // per process, so a second admin surface in the same process cannot add a
            // second scheduler over the same plan file. Advisory only: it never
            // blocks or fails listener startup, and it is dropped with the runtime.
            let admin_state = Arc::new(routecodex_v3_admin::AppState::new(config_path));
            admin_state.spawn_background();
            routecodex_v3_admin::router((*admin_state).clone())
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
                V3WebuiObservability::load_persisted(&observability_store_path);
            observability_writers.push(webui_observability.clone());
            // Each business listener owns its own provider health store,
            // availability generation, failure/action state and recovery
            // scheduler. Requests on this listener share only this handle.
            let listener_scope = V3ProviderHealthListenerScope {
                server_id: server.id.clone(),
                bind: server.bind.clone(),
                port: server.port,
            };
            let mut listener_health =
                V3ResponsesRelayProviderHealthHandle::from_manifest_for_listener(
                    &manifest,
                    &listener_scope,
                );
            if let Some(clock) = observation_clock.as_ref() {
                listener_health = listener_health.with_observation_clock(clock.clone());
            }
            let active_keys = active_key_states.remove(&server.id);
            let listener_provider_health =
                Arc::new(listener_health.with_active_keys(active_keys.clone()));
            provider_health_handles.push(Arc::clone(&listener_provider_health));
            let listener_state = Arc::new(V3ListenerState {
                server,
                manifest_version: preflight.manifest_version,
                manifest: manifest.clone(),
                debug: debug.clone(),
                console_enabled,
                sse_dump_enabled,
                request_counter: Arc::clone(&request_counter),
                codex_sample_store: codex_sample_store.clone(),
                provider_health: listener_provider_health,
                active_keys,
                active_key_control_revoked: Arc::clone(&active_key_control_revoked),
                #[cfg(test)]
                responses_handoff_observer: responses_handoff_observer.clone(),
                image_history: Default::default(),
                realtime_cooled_provider_keys: Arc::new(Mutex::new(BTreeMap::new())),
                request_activity_gate: Arc::clone(&request_activity_gate),
                front_transport_broker: front_transport_broker.clone(),
                webui_observability,
            });
            if listener_state.active_keys.is_some() {
                pending_active_key_controls.push((Arc::clone(&listener_state), addr));
            }
            build_v3_listener_router((*listener_state).clone())
        };
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let connection_broker = front_transport_broker.clone();
        let app_for_serve = app.clone();
        let accept_state = Arc::new(V3ListenerAcceptState::new());
        pending_listener_tasks.push((
            listener,
            app_for_serve,
            shutdown_rx,
            connection_broker,
            Arc::clone(&accept_state),
        ));
        listeners.push(V3ListenerHandle {
            server_id,
            addr,
            shutdown: Some(shutdown_tx),
            accept_state,
            active_key_control_revoked,
        });
    }
    for listener in &listeners {
        // Debug evidence is not business truth: a failing debug sink must not
        // stop listener startup. The failure is announced and startup continues.
        let scope = match debug.start_trace(&listener.server_id, "startup", "listener") {
            Ok(scope) => scope,
            Err(error) => {
                eprintln!(
                    "V3 debug listener startup trace {} unavailable: {error}",
                    listener.server_id
                );
                continue;
            }
        };
        let _ = debug
            .record_node_event(
                &scope,
                "V3ServerStartup01ListenerSetPreflight",
                "listening",
                Some(json!({
                    "server_id": listener.server_id,
                    "address": listener.addr.to_string()
                })),
            )
            .inspect_err(|error| {
                eprintln!(
                    "V3 debug listener startup event {} unavailable: {error}",
                    listener.server_id
                );
            });
    }
    // Codex sample persistence is optional debug capture, never business truth:
    // a persistence worker that cannot start must not stop the aggregate server.
    // The failure is recorded and the store simply keeps no persist worker.
    let codex_sample_persist_worker = match codex_sample_store.start_persist_worker() {
        Ok(worker) => Some(worker),
        Err(error) => {
            eprintln!(
                "V3 codex sample persistence worker unavailable: {error}; continuing without sample persistence"
            );
            None
        }
    };
    for (listener, app_for_serve, shutdown_rx, connection_broker, accept_state) in
        pending_listener_tasks
    {
        tokio::spawn(run_v3_listener_accept_loop(
            listener,
            app_for_serve,
            shutdown_rx,
            connection_broker,
            accept_state,
        ));
    }
    if console_enabled {
        emit_v3_startup_console_line(&listeners);
    }
    let probe_lifecycle = aggregate_probe_lifecycle::AggregateProbeLifecycle::start(
        Arc::clone(&manifest),
        provider_health_handles.clone(),
    )
    .map_err(std::io::Error::other)?;
    let mut handle = V3ServerAggregateHandle {
        listeners,
        #[cfg(test)]
        responses_handoff_observer,
        probe_lifecycle,
        request_activity_gate,
        front_transport_broker,
        provider_health: provider_health_handles,
        observability_writers,
        codex_sample_persist_worker,
        active_key_controls: Vec::new(),
        active_key_control_startup_details: Vec::new(),
    };
    let deadline = tokio::time::Instant::now() + ACTIVE_KEY_CONTROL_ACQUISITION_BUDGET;
    for owner in &mut inherited {
        owner.record_pending = true;
    }
    for (listener_state, addr) in pending_active_key_controls {
        let server_id = &listener_state.server.id;
        let result = async {
            let paths = resolve_active_key_control_paths(
                canonical_admin_config_path.as_deref(),
                server_id,
                deadline,
            )
            .await?;
            let mut predecessor = inherited
                .iter()
                .position(|owner| owner.record_paths == paths)
                .map(|index| inherited.swap_remove(index));
            let published =
                if let Some(control_addr) = active_key_control::control_bind_address(addr) {
                    active_key_control::publish_startup_record(
                        paths,
                        active_key_control::make_record(server_id, addr, control_addr),
                        deadline,
                        predecessor.as_mut(),
                        active_key_startup,
                        #[cfg(test)]
                        control_storage_observer.take(),
                    )
                    .await
                } else {
                    start_active_key_control_companion(
                        &listener_state,
                        paths,
                        addr,
                        deadline,
                        predecessor.as_mut(),
                        active_key_startup,
                        #[cfg(test)]
                        control_storage_observer.take(),
                    )
                    .await
                };
            handle
                .active_key_controls
                .extend(predecessor.filter(|owner| owner.record_pending));
            published
        }
        .await;
        match result {
            Ok(owner) => handle.active_key_controls.push(owner),
            Err(error) => report_active_key_control_startup_failure(
                &mut handle,
                format!("V3 active-key control unavailable for {server_id} at {addr}: {error}"),
            ),
        }
    }
    for mut owner in inherited {
        if let Err(error) = active_key_control::retire_inherited_record_until(
            &mut owner,
            deadline,
            active_key_startup,
        )
        .await
        {
            report_active_key_control_startup_failure(
                &mut handle,
                format!(
                    "V3 active-key control unavailable for inherited retirement: {}",
                    owner.cleanup_failure(error)
                ),
            );
        }
        if owner.record_pending {
            handle.active_key_controls.push(owner);
        }
    }
    if let Some(startup) = active_key_startup {
        startup
            .snapshot()
            .retain_unrepresented_owners(&mut handle.active_key_controls)?;
    }
    Ok(handle)
}

fn report_active_key_control_startup_failure(handle: &mut V3ServerAggregateHandle, detail: String) {
    eprintln!("{detail}; business listeners remain active");
    handle.active_key_control_startup_details.push(detail);
}

pub async fn serve_v3_server_aggregate_until_shutdown(
    manifest: V3Config05ManifestPublished,
) -> Result<(), std::io::Error> {
    let handle = spawn_v3_server_aggregate(manifest).await?;
    tokio::signal::ctrl_c().await?;
    let failures = handle.shutdown().await;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(std::io::Error::other(failures.to_string()))
    }
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
        .route("/v1beta/models/:model", post(pending_endpoint))
        .route("/_routecodex/debug/status", get(debug_status))
        .route("/_routecodex/debug/logs", get(debug_logs))
        .route("/_routecodex/debug/snapshots", get(debug_snapshots))
        .route("/_routecodex/debug/dry-run", post(debug_dry_run))
        .route(
            "/_routecodex/selection/active-keys",
            get(active_keys_status),
        )
        .route(
            "/_routecodex/selection/active-keys/release",
            post(active_keys_release),
        )
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
            get(webui_observability_endpoints::cooldown_pool)
                .post(webui_observability_endpoints::remove_cooldown),
        )
        .route(
            "/_routecodex/health/cooldown-pool/add",
            post(webui_observability_endpoints::add_cooldown),
        )
        .route(
            "/_routecodex/health/cooldown-pool/probe",
            post(webui_observability_endpoints::probe_cooldown),
        )
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(path_not_found)
        .with_state(state)
}

/// Build-version truth for `/health`.
///
/// A status probe must report an unavailable build version instead of turning a
/// failed syscall into a panic: the handler returns the typed internal
/// request-stage projection (598) through the server error channel.
fn resolve_v3_health_build_version() -> Result<String, String> {
    let executable_path = std::env::current_exe()
        .map_err(|error| format!("current executable path is unavailable: {error}"))?;
    resolve_routecodex_package_version_from_executable(&executable_path).ok_or_else(|| {
        format!(
            "installed package build_version is unavailable for {}",
            executable_path.display()
        )
    })
}

async fn health(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    let build_version = match resolve_v3_health_build_version() {
        Ok(build_version) => build_version,
        Err(detail) => {
            return match project_v3_server_boundary_error_via_sdk(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ServerHealth",
                "health_build_version_unavailable",
                detail,
                Some(598),
            ) {
                Ok(projected) => json_response(projected.status, projected.body),
                Err(fault) => foundation_output_response(foundation_output_from_error_sdk_result(
                    "V3ServerHealth",
                    vec!["V3ServerHealth"],
                    None,
                    Err(fault),
                )),
            };
        }
    };
    json_response(
        200,
        json!({
            "status": "ok",
            "version": 3,
            "build_version": build_version,
            "manifest_version": state.manifest_version,
            "server_id": state.server.id,
            "bind": state.server.bind,
            "port": state.server.port,
        }),
    )
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
            project_v3_server_boundary_error_via_sdk(
                V3ErrorSourceKind::InvalidRequest,
                "V3Server03HttpRequestRaw",
                "forbidden",
                "forbidden",
                Some(403),
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
            project_v3_server_boundary_error_via_sdk(
                V3ErrorSourceKind::RuntimeFailure,
                "V3RouterDiagnostics",
                "virtual_router_diagnostics_failed",
                message,
                Some(500),
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
            project_v3_server_boundary_error_via_sdk(
                V3ErrorSourceKind::InvalidRequest,
                "V3Server03HttpRequestRaw",
                "forbidden",
                "forbidden",
                Some(403),
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
                *projected,
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
            project_v3_server_boundary_error_via_sdk(
                V3ErrorSourceKind::RuntimeFailure,
                "V3RouterDiagnostics",
                "virtual_router_dry_run_failed",
                message,
                Some(500),
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

fn configure_listener_active_keys(
    manifest: &V3Config05ManifestPublished,
    server: &V3ServerManifest,
    state: &V3ActiveKeySelectionState,
) -> Result<(), std::io::Error> {
    for (pool_id, pool) in V3TargetInterpreter::default()
        .active_key_pool_declarations(manifest, &server.routing_group)
        .map_err(std::io::Error::other)?
    {
        let scope = V3ActiveKeyScope {
            listener_id: server.id.clone(),
            routing_group_id: server.routing_group.clone(),
            pool_id: pool_id.clone(),
        };
        state
            .configure(scope, pool.policy, pool.strategy, &pool.universe)
            .map_err(std::io::Error::other)?;
    }
    Ok(())
}

fn active_key_identity_json(identity: &V3ActiveKeyIdentity) -> Value {
    json!({
        "provider_id": identity.provider_id,
        "interface_id": identity.interface_id,
        "model_id": identity.model_id,
        "auth_alias": identity.auth_alias,
    })
}

fn active_keys_control_router(state: Arc<V3ListenerState>) -> Router {
    Router::new()
        .route(
            "/_routecodex/selection/active-keys",
            get(active_keys_status),
        )
        .route(
            "/_routecodex/selection/active-keys/release",
            post(active_keys_release),
        )
        .with_state(state)
}

async fn start_active_key_control_companion(
    state: &Arc<V3ListenerState>,
    paths: routecodex_v3_config::V3ActiveKeyControlPaths,
    business_addr: SocketAddr,
    deadline: tokio::time::Instant,
    inherited: Option<&mut ActiveKeyControlOwner>,
    startup: Option<&V3ActiveKeyControlStartup>,
    #[cfg(test)] observer: Option<active_key_control::StorageBoundaryObserver>,
) -> io::Result<ActiveKeyControlOwner> {
    let bind = active_key_control::companion_bind_address();
    let listener = bind_v3_tcp_listener_retry_eintr(|| TcpListener::bind(bind)).await?;
    let control_addr = listener.local_addr()?;
    if !control_addr.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "active-key control companion did not bind loopback",
        ));
    }
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = active_keys_control_router(Arc::clone(state));
    let broker = V3FrontTransportBroker::default();
    let task = tokio::spawn(run_v3_listener_accept_loop(
        listener,
        app,
        shutdown_rx,
        broker.clone(),
        Arc::new(V3ListenerAcceptState::new()),
    ));
    let mut transport = ActiveKeyControlTransport {
        task,
        shutdown: Some(shutdown_tx),
        broker,
    };
    let result = active_key_control::publish_startup_record(
        paths,
        active_key_control::make_record(&state.server.id, business_addr, control_addr),
        deadline,
        inherited,
        startup,
        #[cfg(test)]
        observer,
    )
    .await;
    match result {
        Ok(mut owner) => {
            owner.transport = Some(transport);
            Ok(owner)
        }
        Err(error) => {
            transport.close().await;
            Err(error)
        }
    }
}

async fn resolve_active_key_control_paths(
    config_path: Option<&std::path::Path>,
    server_id: &str,
    deadline: tokio::time::Instant,
) -> io::Result<routecodex_v3_config::V3ActiveKeyControlPaths> {
    if tokio::time::Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "active-key control publication acquisition deadline elapsed",
        ));
    }
    let config_path = config_path.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "canonical config path is unavailable",
        )
    })?;
    let config_path = config_path.to_path_buf();
    let server_id = server_id.to_owned();
    tokio::time::timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || {
            active_key_control::record_path(&config_path, &server_id)
        }),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "active-key control publication acquisition deadline elapsed",
        )
    })?
    .map_err(io::Error::other)?
}

async fn active_keys_status(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response<Body> {
    if !remote.ip().is_loopback() {
        return json_response(403, json!({"error":"loopback_only"}));
    }
    let access = state.active_key_control_revoked.read().unwrap();
    if *access {
        return json_response(
            410,
            json!({"error":"active key controls have been released"}),
        );
    }
    let Some(active_keys) = &state.active_keys else {
        return json_response(200, json!({"pools":[]}));
    };
    let Some(group) = state.manifest.route_groups.get(&state.server.routing_group) else {
        return json_response(200, json!({"pools":[]}));
    };
    let mut pools = Vec::new();
    for (pool_id, pool) in &group.pools {
        let Some(policy) = &pool.active_keys else {
            continue;
        };
        let scope = V3ActiveKeyScope {
            listener_id: state.server.id.clone(),
            routing_group_id: state.server.routing_group.clone(),
            pool_id: pool_id.clone(),
        };
        let snapshot = match active_keys.snapshot(&scope) {
            Ok(snapshot) => snapshot,
            Err(error) => return json_response(500, json!({"error":error.to_string()})),
        };
        let order = snapshot
            .order
            .iter()
            .map(active_key_identity_json)
            .collect::<Vec<_>>();
        let held = snapshot
            .held
            .iter()
            .map(active_key_identity_json)
            .collect::<Vec<_>>();
        let configured_members = policy
            .members
            .iter()
            .map(|member| json!({"provider":member.provider,"alias":member.alias}))
            .collect::<Vec<_>>();
        let health = snapshot.order.iter().map(|identity| {
            let (eligible, reason) = state.provider_health.active_key_health_status(identity, current_epoch_ms());
            json!({"provider_id":identity.provider_id,"interface_id":identity.interface_id,"model_id":identity.model_id,"auth_alias":identity.auth_alias,"eligible":eligible,"reason":reason})
        }).collect::<Vec<_>>();
        pools.push(json!({"routing_group_id":scope.routing_group_id,"pool_id":scope.pool_id,"strategy":snapshot.strategy,"configured_members":configured_members,"order":order,"held":held,"health":health,"persistence_error":snapshot.persistence_error}));
    }
    json_response(200, json!({"pools":pools}))
}

#[derive(Debug, Deserialize)]
struct ActiveKeyReleaseRequest {
    routing_group_id: String,
    pool_id: String,
    provider_id: String,
    interface_id: String,
    model_id: String,
    auth_alias: String,
}

async fn active_keys_release(
    State(state): State<Arc<V3ListenerState>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response<Body> {
    if !remote.ip().is_loopback() {
        return json_response(403, json!({"error":"loopback_only"}));
    }
    let Some(active_keys) = &state.active_keys else {
        return json_response(404, json!({"error":"active keys are not configured"}));
    };
    let payload = match read_json_payload(request).await {
        Ok(value) => value,
        Err(_) => return json_response(400, json!({"error":"invalid_json"})),
    };
    let body: ActiveKeyReleaseRequest = match serde_json::from_value(payload) {
        Ok(body) => body,
        Err(error) => return json_response(400, json!({"error":error.to_string()})),
    };
    let scope = V3ActiveKeyScope {
        listener_id: state.server.id.clone(),
        routing_group_id: body.routing_group_id,
        pool_id: body.pool_id,
    };
    let identity = V3ActiveKeyIdentity {
        provider_id: body.provider_id,
        interface_id: body.interface_id,
        model_id: body.model_id,
        auth_alias: body.auth_alias,
    };
    let access = state.active_key_control_revoked.read().unwrap();
    if *access {
        return json_response(
            410,
            json!({"error":"active key controls have been released"}),
        );
    }
    match active_keys.release(&scope, &identity) {
        Ok(changed) => json_response(
            200,
            json!({"released":changed,"identity":active_key_identity_json(&identity)}),
        ),
        Err(error) => {
            let status = if matches!(
                error,
                routecodex_v3_target::V3ActiveKeyStateError::UnknownScope
                    | routecodex_v3_target::V3ActiveKeyStateError::UnknownMember
            ) {
                404
            } else {
                500
            };
            json_response(status, json!({"error":error.to_string()}))
        }
    }
}

async fn pending_endpoint(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let connection = request
        .extensions()
        .get::<V3FrontConnectionIdentity>()
        .copied();
    let response = pending_model_request(state.clone(), request).await;
    commit_model_transport_outcome(&state, connection, response)
}

async fn pending_model_request(state: Arc<V3ListenerState>, request: Request) -> Response<Body> {
    let front_socket = request
        .extensions()
        .get::<restart_handoff::V3StableFrontSocket>()
        .cloned();
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
                if path.starts_with("/v1beta/models/") {
                    V3HttpBoundaryErrorKind::PathNotFound
                } else {
                    V3HttpBoundaryErrorKind::EndpointNotEnabled
                },
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
            let projected = match *projected {
                Ok(projected) => projected,
                Err(fault) => {
                    persist_v3_chat_failure_evidence_sources(
                        &state,
                        &entry_protocol,
                        &path,
                        &request_id,
                        &[],
                        Some(fault.policy_failure.as_ref()),
                        fault.original_source.as_deref(),
                    );
                    return foundation_output_response(foundation_output_from_error_sdk_result(
                        "V3Server03HttpRequestRaw",
                        vec!["V3Server03HttpRequestRaw"],
                        None,
                        Err(fault),
                    ));
                }
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
            // Capture the typed Error06 side-channel truth before the projection
            // is consumed by the Server16 frame builder. Forwarded verbatim.
            let error06_error_class = projected.error_class;
            let error06_health_action = projected.health_action.clone();
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
                    execution_mode: None,
                    error06_exposed: true,
                    error_class: Some(error06_error_class),
                    health_action: error06_health_action.as_ref(),
                    diagnostic_source: None,
                    terminal_disposition: None,
                    // V3Error06ClientProjected does not carry the Error01
                    // external link, so this lane records "not exposed".
                    upstream_request_id: None,
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
    let request_activity_permit = state.request_activity_gate.admit().await;
    // The Runtime owns full-attempt buffering, so no provider payload byte is
    // projected before the runtime outcome exists. The Server owns the client
    // transport: a client that requested SSE must not stay on a silent
    // connection for longer than one keepalive interval while the runtime
    // buffers the attempt.
    let client_sse_channel = (v3_request_wants_sse(&request_headers, &payload)
        || (entry_protocol == "gemini" && path.ends_with(":streamGenerateContent")))
    .then_some(Duration::from_millis(state.server.http_sse_keepalive_ms))
    .filter(|interval| !interval.is_zero());
    let client_disconnect_slot = client_sse_channel
        .is_some()
        .then(V3ClientDisconnectSlot::new);
    let runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>> =
        Box::pin(pending_endpoint_after_json_parse(
            Arc::clone(&state),
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
            client_disconnect_slot.clone(),
        ));
    let response = match client_sse_channel {
        Some(keepalive_interval) => {
            let outcome_state = Arc::clone(&state);
            // The committed channel owns the response head, so the client-response
            // sample recorder cannot travel through the runtime outcome response.
            // The channel hands it to this slot and the boundary reads it here.
            let client_wire_capture = client_response_wire_capture_enabled(&state)
                .then(V3LiveSnapClientWireCaptureSlot::new);
            accept_v3_client_sse_transport(
                runtime_outcome,
                Box::new(move |outcome| {
                    commit_model_transport_outcome(
                        &outcome_state,
                        front_connection_identity,
                        outcome,
                    )
                }),
                keepalive_interval,
                client_wire_capture,
                client_disconnect_slot,
            )
            .await
        }
        None => runtime_outcome.await,
    };
    let response =
        hold_response_body_request_activity_permit(response, request_activity_permit, front_socket);
    // The client-response sample must record the wire the client receives, so the
    // recorder wraps the final body after every transport owner has framed it.
    observe_v3_live_client_wire(response)
}

/// Whether this request can produce a client-response sample.
///
/// The transport boundary wraps the final client wire only when a sample can be
/// recorded, so an unsampled request pays no per-chunk capture cost.
fn client_response_wire_capture_enabled(state: &V3ListenerState) -> bool {
    state.debug.should_capture_snapshot_stage("client-response")
        || state
            .debug
            .should_capture_snapshot_stage("provider-response")
}

/// v3.protocol.pending_projection：尚未实现协议绑定的客户端响应统一由
/// foundation pending 投影出站（见 v3-resource-operation-map.yml 同名资源）。
fn pending_binding_output_response(
    state: &V3ListenerState,
    output: V3FoundationRuntimeOutput,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    _pending_not_implemented: &str,
    _pending_owner: &str,
) -> Response<Body> {
    persist_v3_chat_failure_evidence_sources(
        state,
        entry_protocol,
        endpoint,
        request_id,
        &[],
        output.diagnostic_source.as_ref(),
        output.diagnostic_cause.as_ref(),
    );
    foundation_output_response(output)
}

struct V3ErrorProjectionConsoleInput<'input> {
    execution_mode: Option<&'input str>,
    endpoint: &'input str,
    request_id: &'input str,
    entry_protocol: &'input str,
    session_id: Option<&'input str>,
    status: u16,
    error_chain: &'input [&'static str],
    body: Option<&'input Value>,
    project_path: Option<&'input str>,
    /// Typed Error01 source already held by the current terminal output.
    diagnostic_source: Option<&'input routecodex_v3_error::V3Error01SourceRaised>,
    /// Typed provider terminal already held by the current output. When present,
    /// the ledger derives provider status and category from this fact instead of
    /// the internally projected client body.
    terminal_disposition: Option<&'input routecodex_v3_error::V3ProviderTerminalDisposition>,
    /// `true` when this lane holds the typed `V3Error06ClientProjected`. Lanes
    /// that only carry the chain record an explicit "not exposed" marker.
    error06_exposed: bool,
    /// `V3Error06ClientProjected.error_class`, forwarded verbatim.
    error_class: Option<&'input str>,
    /// `V3Error06ClientProjected.health_action`, forwarded verbatim.
    health_action: Option<&'input routecodex_v3_error::V3ErrorActionPlan>,
    /// `V3Error01SourceRaised.external_error.upstream_request_id`, when exposed.
    upstream_request_id: Option<&'input str>,
}

/// relay 分支共享：error_chain 存在时做 console 投影（4 个 relay 分支同构样板收敛）。
/// The relay lanes expose only the chain, so they record the honest
/// "Error06 typed truth not exposed on this lane" marker.
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
            execution_mode: Some("relay"),
            error06_exposed: false,
            error_class: None,
            health_action: None,
            diagnostic_source: None,
            terminal_disposition: None,
            upstream_request_id: None,
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
        webui_observability::V3ObsErrorProjection {
            execution_mode: input.execution_mode,
            exposed: input.error06_exposed,
            error_class: input.error_class,
            error_chain: input.error_chain,
            health_action: input.health_action,
            diagnostic_source: input.diagnostic_source,
            terminal_disposition: input.terminal_disposition,
            upstream_request_id: input.upstream_request_id,
            ..Default::default()
        },
    ) {
        let line = format_v3_console_timed_content(
            "[webui-observability]",
            &format!("req={} error={}", input.request_id, error),
        );
        append_v3_human_console_line(state, &line);
    }
    None
}

fn responses_client_identity_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    V3_RESPONSES_CLIENT_IDENTITY_HEADER_NAMES
        .iter()
        .copied()
        .filter(|name| {
            !headers
                .get_all("connection")
                .iter()
                .filter_map(|value| value.to_str().ok())
                .flat_map(|value| value.split(','))
                .any(|option| option.trim().eq_ignore_ascii_case(name))
        })
        .filter_map(|name| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(|value| (name.to_owned(), value.to_owned()))
        })
        .collect()
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
) -> Result<Option<V3ProviderFailureSessionScope>, String> {
    let (session_id, _) = responses_control_scope_headers(headers, None)?;
    session_id
        .map(|session_id| {
            V3ProviderFailureSessionScope::new(&server.id, &server.routing_group, &session_id)
        })
        .transpose()
}

/// Get the provider-failure control scope without changing the client request.
///
/// A client session control header is optional request data.
/// It is useful when present, but it is not a prerequisite for an ordinary
/// request. Requests without one use their already allocated internal request
/// id as a request-local control-scope key.
fn get_failure_session_scope(
    server: &V3ServerManifest,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<V3ProviderFailureSessionScope, String> {
    if let Some(scope) = build_v3_provider_failure_session_scope_for_request(server, headers)? {
        return Ok(scope);
    }
    Ok(V3ProviderFailureSessionScope::new(
        &server.id,
        &server.routing_group,
        format!("request-local-{request_id}"),
    )?
    .as_request_local())
}

/// Record private Chat Relay failure evidence through the shared serializer.
pub(crate) fn persist_v3_chat_failure_evidence(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &V3OpenAiChatRelayRuntimeOutput,
) {
    let attempts = match output.observability.as_ref() {
        Some(observation) => &observation.provider_failure_events,
        None => &output.provider_failure_attempts,
    };
    persist_v3_chat_failure_evidence_sources(
        state,
        entry_protocol,
        endpoint,
        request_id,
        attempts,
        output.diagnostic_source.as_ref(),
        output.diagnostic_cause.as_ref(),
    );
}

pub(crate) fn persist_v3_anthropic_relay_failure_evidence(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    request_id: &str,
    output: &routecodex_v3_runtime::V3AnthropicRelayRuntimeOutput,
) {
    let attempts = output
        .observability
        .as_ref()
        .map_or(output.provider_failure_attempts.as_slice(), |observation| {
            observation.provider_failure_events.as_slice()
        });
    persist_v3_chat_failure_evidence_sources(
        state,
        "anthropic",
        endpoint,
        request_id,
        attempts,
        output.diagnostic_source.as_ref(),
        output.diagnostic_cause.as_ref(),
    );
}

pub(crate) fn persist_v3_gemini_relay_failure_evidence(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    request_id: &str,
    output: &routecodex_v3_runtime::V3GeminiRelayRuntimeOutput,
) {
    let attempts = output
        .observability
        .as_ref()
        .map_or(output.provider_failure_attempts.as_slice(), |observation| {
            observation.provider_failure_events.as_slice()
        });
    persist_v3_chat_failure_evidence_sources(
        state,
        "gemini",
        endpoint,
        request_id,
        attempts,
        output.diagnostic_source.as_ref(),
        output.diagnostic_cause.as_ref(),
    );
}

pub(crate) fn persist_v3_responses_relay_failure_sources(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    output: &routecodex_v3_runtime::V3ResponsesRelayRuntimeOutput,
) {
    let attempts = output
        .observability
        .as_ref()
        .map_or(&[][..], |observation| {
            observation.provider_failure_events.as_slice()
        });
    persist_v3_chat_failure_evidence_sources(
        state,
        entry_protocol,
        endpoint,
        request_id,
        attempts,
        output.diagnostic_source.as_ref(),
        output.diagnostic_cause.as_ref(),
    );
}
#[cfg(test)]
mod tests;
