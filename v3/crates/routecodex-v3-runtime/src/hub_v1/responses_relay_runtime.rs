use super::*;
use crate::V3LocalContinuationReq04RestoreRequest;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_from_v3_error_03,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05, V3ErrorActionScope, V3ErrorSourceKind,
    V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_v3_provider_12, ReqwestResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader, V3ProviderAvailabilityRegistry,
    V3ProviderError, V3ProviderHealthStore, V3ProviderResponseBody, V3ResponsesProviderTarget,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const V3_RESPONSES_RELAY_LOCAL_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;
const V3_RESPONSES_RELAY_SSE_EOF_WITHOUT_TERMINAL_MESSAGE: &str =
    "provider SSE stream ended before response.completed";
const V3_RESPONSES_RELAY_SSE_FAILED_MESSAGE: &str =
    "provider SSE stream failed before response.completed";
const V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_COUNT: usize = 3;
const V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_DELAY_MS: u64 = 5_000;

pub type V3ResponsesRelayClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3RuntimeSseTerminal {
    Completed,
    Failed,
}

struct V3ObservedSseState {
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    decoder: SseIncrementalDecoder,
    observation: V3RuntimeStreamObservation,
    ready: VecDeque<Vec<u8>>,
    terminal_seen: bool,
    done: bool,
}

pub enum V3ResponsesRelayClientBody {
    Json(Value),
    Sse(V3ResponsesRelayClientStream),
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ResponsesRelayRuntimeInput {
    pub server_id: String,
    pub request_id: String,
    pub payload: Value,
}

pub struct V3ResponsesRelayRuntimeOutput {
    pub status: u16,
    pub client_body: V3ResponsesRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub observability: Option<V3RuntimeObservability>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3ResponsesRelayRetryPolicy {
    pub same_candidate_retries: usize,
    pub retry_delay_ms: u64,
}

impl Default for V3ResponsesRelayRetryPolicy {
    fn default() -> Self {
        Self {
            same_candidate_retries: V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_COUNT,
            retry_delay_ms: V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_DELAY_MS,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3RuntimeUsageSummary {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3RuntimeObservability {
    pub entry_protocol: String,
    pub execution_mode: String,
    pub transport: String,
    pub routing_group_id: Option<String>,
    pub pool_id: Option<String>,
    pub provider_id: Option<String>,
    pub auth_alias: Option<String>,
    pub provider_key: Option<String>,
    pub provider_type: Option<String>,
    pub model_id: Option<String>,
    pub wire_model: Option<String>,
    pub provider_status: Option<u16>,
    pub response_status: Option<String>,
    pub attempts: Option<usize>,
    pub unavailable_candidates: Vec<String>,
    pub target_path: Vec<String>,
    pub usage: Option<V3RuntimeUsageSummary>,
}

#[derive(Debug, Clone, Default)]
pub struct V3RuntimeStreamObservation {
    inner: Arc<Mutex<V3RuntimeStreamObservationSnapshot>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3RuntimeStreamObservationSnapshot {
    pub response_status: Option<String>,
    pub usage: Option<V3RuntimeUsageSummary>,
}

struct V3ResponsesRelayProviderFailure {
    status: u16,
    client_response: Value,
    provider_id: String,
    observability: Option<V3RuntimeObservability>,
}

struct V3ResponsesRelayExcludedAvailability<'excluded> {
    base: V3ProviderAvailabilityRegistry,
    excluded: &'excluded BTreeSet<String>,
}

struct V3ResponsesRelayProviderFailureContext<'ctx> {
    manifest: &'ctx V3Config05ManifestPublished,
    server_id: &'ctx str,
    provider_semantic_body: &'ctx Value,
    provider_health: &'ctx V3ProviderHealthStore,
    retry_policy: &'ctx V3ResponsesRelayRetryPolicy,
}

struct V3ResponsesRelayProviderRetryState<'state> {
    failed_candidates: &'state mut BTreeSet<String>,
    same_candidate_retries: &'state mut BTreeMap<String, usize>,
    retry_selected: &'state mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_provider_failure: &'state mut Option<V3ResponsesRelayProviderFailure>,
    trace: &'state mut Vec<&'static str>,
}

impl V3ProviderAvailabilityReader for V3ResponsesRelayExcludedAvailability<'_> {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self
            .base
            .availability(provider_id, auth_alias, model_id, now_ms);
        let key = v3_responses_relay_candidate_key_parts(provider_id, auth_alias, model_id);
        if self.excluded.contains(&key) {
            projection.available = false;
            projection
                .blocked_scopes
                .push("request_local_provider_failure".to_string());
        }
        projection
    }
}

impl V3RuntimeStreamObservation {
    pub fn snapshot(&self) -> Result<V3RuntimeStreamObservationSnapshot, String> {
        self.inner
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "V3 runtime stream observation state lock is poisoned".to_string())
    }

    fn record_event(&self, event: &Value) -> Result<(), String> {
        let semantic = event.get("response").unwrap_or(event);
        let response_status = semantic
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| !status.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                event
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| !status.trim().is_empty())
                    .map(str::to_string)
            });
        let usage = extract_v3_runtime_usage_summary(semantic)
            .or_else(|| extract_v3_runtime_usage_summary(event));
        if response_status.is_none() && usage.is_none() {
            return Ok(());
        }
        let mut snapshot = self
            .inner
            .lock()
            .map_err(|_| "V3 runtime stream observation state lock is poisoned".to_string())?;
        if response_status.is_some() {
            snapshot.response_status = response_status;
        }
        if usage.is_some() {
            snapshot.usage = usage;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesRelayLocalContinuationScope {
    entry_endpoint: String,
    session_id: String,
    conversation_id: String,
    port: u16,
    routing_group: String,
}

impl V3ResponsesRelayLocalContinuationScope {
    pub fn responses(
        entry_endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            entry_endpoint: entry_endpoint.into(),
            session_id: session_id.into(),
            conversation_id: conversation_id.into(),
            port,
            routing_group: routing_group.into(),
        }
    }

    fn local_key(&self) -> V3LocalContinuationScopeKey {
        V3LocalContinuationScopeKey::responses(
            self.entry_endpoint.clone(),
            self.session_id.clone(),
            self.conversation_id.clone(),
            self.port,
            self.routing_group.clone(),
        )
    }

    fn hub_scope(&self, server_id: &str) -> V3HubContinuationScope {
        V3HubContinuationScope::new(
            V3HubEntryProtocol::Responses,
            server_id,
            self.routing_group.clone(),
            self.session_id.clone(),
        )
    }
}

#[derive(Debug, Default)]
pub struct V3ResponsesRelayLocalContinuationState {
    store: Mutex<V3LocalContinuationStore>,
}

impl V3ResponsesRelayLocalContinuationState {
    pub fn len(&self) -> Result<usize, V3ResponsesRelayRuntimeError> {
        Ok(self.lock_store()?.len())
    }

    pub fn is_empty(&self) -> Result<bool, V3ResponsesRelayRuntimeError> {
        Ok(self.lock_store()?.is_empty())
    }

    fn lock_store(
        &self,
    ) -> Result<MutexGuard<'_, V3LocalContinuationStore>, V3ResponsesRelayRuntimeError> {
        self.store
            .lock()
            .map_err(|_| V3ResponsesRelayRuntimeError::LocalContinuationStatePoisoned)
    }
}

impl std::fmt::Debug for V3ResponsesRelayRuntimeOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3ResponsesRelayRuntimeOutput")
            .field("status", &self.status)
            .field(
                "client_body",
                &match self.client_body {
                    V3ResponsesRelayClientBody::Json(_) => "json",
                    V3ResponsesRelayClientBody::Sse(_) => "sse",
                },
            )
            .field("node_trace", &self.node_trace)
            .field("error_chain", &self.error_chain)
            .field("observability", &self.observability)
            .field("stream_observation", &self.stream_observation)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3ResponsesRelayRuntimeError {
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 Responses Relay target resolution failed: {0}")]
    Target(String),
    #[error("V3 Responses Relay provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 Responses Relay provider health failed: {0}")]
    ProviderHealth(String),
    #[error("V3 Responses Relay JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error(transparent)]
    LocalContinuation(#[from] V3LocalContinuationError),
    #[error("V3 Responses Relay local continuation scope routing group does not match server")]
    LocalContinuationScopeMismatch,
    #[error("V3 Responses Relay local continuation state lock is poisoned")]
    LocalContinuationStatePoisoned,
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime(manifest, input, &ReqwestResponsesTransport::default()).await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_and_local_continuation(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_local_continuation(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        state,
        scope,
        now_epoch_ms,
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_and_local_continuation(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ProviderHealthStore,
    state: &V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
        }),
        provider_health.clone(),
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_retry_policy(
        manifest,
        input,
        transport,
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_retry_policy<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    retry_policy: V3ResponsesRelayRetryPolicy,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let provider_health = V3ProviderHealthStore::from_manifest(manifest);
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        None,
        provider_health,
        retry_policy,
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_health_and_retry_policy<
    T: ResponsesTransport,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    provider_health: &V3ProviderHealthStore,
    retry_policy: V3ResponsesRelayRetryPolicy,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        None,
        provider_health.clone(),
        retry_policy,
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_local_continuation<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    state: &V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let provider_health = V3ProviderHealthStore::from_manifest(manifest);
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
        }),
        provider_health,
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

struct V3ResponsesRelayLocalContinuationExecution<'state> {
    state: &'state V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
}

async fn execute_v3_responses_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    provider_health: V3ProviderHealthStore,
    retry_policy: V3ResponsesRelayRetryPolicy,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3ResponsesRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(15);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let requested_local_ids = find_responses_tool_output_ids(&input.payload)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    trace.push("V3HubReqInbound02Normalized");
    let base_hub_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        &input.server_id,
        server_routing_group(manifest, &input.server_id)?,
        &input.request_id,
    );
    let mut restored_context = None;
    let lookup =
        if let (Some(local), Some(context_id)) = (local.as_ref(), requested_local_ids.first()) {
            if local.scope.routing_group != server_routing_group(manifest, &input.server_id)? {
                return Err(V3ResponsesRelayRuntimeError::LocalContinuationScopeMismatch);
            }
            let request = V3LocalContinuationReq04RestoreRequest::local(
                context_id,
                local.scope.local_key(),
                local.now_epoch_ms,
            );
            let store = local.state.lock_store()?;
            let context = store
                .restore_at_req04(&request)?
                .canonical_context()
                .clone();
            for additional_id in requested_local_ids.iter().skip(1) {
                let additional = store
                    .restore_at_req04(&V3LocalContinuationReq04RestoreRequest::local(
                        additional_id,
                        local.scope.local_key(),
                        local.now_epoch_ms,
                    ))?
                    .canonical_context();
                if additional != &context {
                    return Err(V3LocalContinuationError::Codec {
                        message: "tool outputs reference different local continuation contexts"
                            .to_string(),
                    }
                    .into());
                }
            }
            drop(store);
            restored_context = Some(context.clone());
            V3HubContinuationLookup::new(Some(context_id), local.scope.hub_scope(&input.server_id))
                .with_local_context(context_id, local.scope.hub_scope(&input.server_id), context)
        } else {
            V3HubContinuationLookup::new(None, base_hub_scope)
        };
    let request_outcome = compile_v3_hub_relay_request_hooks().run_from_normalized(
        req02,
        &lookup,
        &V3HubServertoolRequestProfile::disabled(),
    )?;
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let mut req04 = request_outcome.into_governed();
    if let Some(context) = restored_context.as_ref() {
        merge_v3_relay_restored_local_context_at_req04(
            &mut req04.previous.previous.previous.payload.0,
            context,
        )?;
    }
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let provider_semantic_body = req05.previous.previous.previous.previous.payload.0.clone();
    let mut failed_candidates = BTreeSet::new();
    let mut pending_provider_failure: Option<V3ResponsesRelayProviderFailure> = None;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut provider_send_attempts = 0usize;
    let failure_context = V3ResponsesRelayProviderFailureContext {
        manifest,
        server_id: &input.server_id,
        provider_semantic_body: &provider_semantic_body,
        provider_health: &provider_health,
        retry_policy: &retry_policy,
    };
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else {
            match resolve_target(
                manifest,
                &input.server_id,
                &provider_semantic_body,
                &failed_candidates,
                &provider_health,
                v3_responses_relay_now_epoch_ms()?,
            ) {
                Ok(selected) => selected,
                Err(error) => {
                    if let Some(failure) = pending_provider_failure.take() {
                        return Ok(provider_failure_output(failure, trace, 0));
                    }
                    return Err(error);
                }
            }
        };
        if pending_provider_failure.take().is_some() {
            trace.push("V3TargetLocalReselected");
        }
        provider_send_attempts = provider_send_attempts.saturating_add(1);
        let mut selected_observability =
            build_v3_relay_observability_from_selected(&selected, transport_intent);
        selected_observability.attempts = Some(provider_send_attempts);
        let selected_target_provider_id = selected.candidate.provider_id.clone();
        let selected_target_auth_alias = selected.candidate.auth_alias.clone();
        let selected_target_model_id = selected.candidate.model_id.clone();
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
            req06,
            V3HubProviderWireProtocol::Responses,
        );
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target())?;
        let req08 = build_v3_provider_req_outbound_08_from_v3_hub_req_outbound_07(req07);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = _req09
            .previous
            .previous
            .previous
            .previous
            .previous
            .previous
            .previous
            .previous
            .payload
            .0
            .clone();
        let wire = build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        )?;
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request =
            build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)?;
        trace.push("V3ProviderReqOutbound09TransportRequest");
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                let failure = provider_http_failure(
                    response.status,
                    &response.body,
                    &selected_target_provider_id,
                    Some(selected_observability),
                );
                handle_v3_responses_relay_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut V3ResponsesRelayProviderRetryState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        retry_selected: &mut retry_selected,
                        pending_provider_failure: &mut pending_provider_failure,
                        trace: &mut trace,
                    },
                )
                .await?;
                continue;
            }
            Err(error) => {
                let failure = provider_runtime_failure(
                    error,
                    &selected_target_provider_id,
                    Some(selected_observability),
                );
                handle_v3_responses_relay_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut V3ResponsesRelayProviderRetryState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        retry_selected: &mut retry_selected,
                        pending_provider_failure: &mut pending_provider_failure,
                        trace: &mut trace,
                    },
                )
                .await?;
                continue;
            }
        };
        let provider_status = provider_raw.status();
        let provider_id = provider_raw.provider_id().to_string();
        provider_health
            .record_provider_success(
                &selected_target_provider_id,
                Some(&selected_target_auth_alias),
                Some(&selected_target_model_id),
                v3_responses_relay_now_epoch_ms()?,
            )
            .map_err(|error| V3ResponsesRelayRuntimeError::ProviderHealth(error.to_string()))?;
        match provider_raw.into_body() {
            V3ProviderResponseBody::Json(bytes) => {
                let provider_value: Value = serde_json::from_slice(&bytes)?;
                let (action, finalized_provider_value) =
                    run_json_response_hooks(&provider_value, transport_intent, &mut trace)?;
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &requested_local_ids,
                    &finalized_provider_value,
                    action,
                )?;
                let mut observability = selected_observability;
                observability.provider_status = Some(provider_status);
                observability.provider_id = Some(provider_id);
                observability.transport = "json".to_string();
                observability.response_status =
                    read_v3_runtime_response_status(&finalized_provider_value);
                observability.usage = extract_v3_runtime_usage_summary(&finalized_provider_value);
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body: V3ResponsesRelayClientBody::Json(finalized_provider_value),
                    node_trace: trace,
                    error_chain: None,
                    observability: Some(observability),
                    stream_observation: None,
                });
            }
            V3ProviderResponseBody::Sse(stream) => {
                push_streaming_response_trace(&mut trace);
                let mut observability = selected_observability;
                observability.provider_status = Some(provider_status);
                observability.provider_id = Some(provider_id);
                observability.transport = "sse".to_string();
                observability.response_status = Some("streaming".to_string());
                let stream_observation = V3RuntimeStreamObservation::default();
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body: V3ResponsesRelayClientBody::Sse(project_sse_stream(
                        stream,
                        stream_observation.clone(),
                    )),
                    node_trace: trace,
                    error_chain: None,
                    observability: Some(observability),
                    stream_observation: Some(stream_observation),
                });
            }
        }
    }
}

fn find_responses_tool_output_ids(
    payload: &Value,
) -> Result<Vec<String>, V3ResponsesRelayRuntimeError> {
    let paired_call_ids = payload_input_paired_call_ids(payload);
    let mut ids = Vec::new();
    for item in payload
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if !matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call_output" | "custom_tool_call_output" | "tool_call_output")
        ) {
            continue;
        }
        let id = item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Responses tool output requires call_id".to_string(),
            })?;
        if paired_call_ids.iter().any(|paired| paired == id) {
            continue;
        }
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

async fn handle_v3_responses_relay_provider_failure(
    context: &V3ResponsesRelayProviderFailureContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    failure: V3ResponsesRelayProviderFailure,
    state: &mut V3ResponsesRelayProviderRetryState<'_>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let candidate_key = v3_responses_relay_candidate_key(&selected.candidate);
    let reason = failure
        .client_response
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/type")
                .and_then(Value::as_str)
        });
    context
        .provider_health
        .record_provider_failure(
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            reason,
            v3_responses_relay_now_epoch_ms()?,
        )
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderHealth(error.to_string()))?;
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    let alternative_available = resolve_target(
        context.manifest,
        context.server_id,
        context.provider_semantic_body,
        &excluded_with_failed,
        context.provider_health,
        v3_responses_relay_now_epoch_ms()?,
    )
    .is_ok();
    if alternative_available {
        state.failed_candidates.insert(candidate_key);
        *state.pending_provider_failure = Some(failure);
        return Ok(());
    }
    let retries_done = state
        .same_candidate_retries
        .entry(candidate_key.clone())
        .or_insert(0);
    if *retries_done < context.retry_policy.same_candidate_retries {
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3TargetLocalRetried");
        if context.retry_policy.retry_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(context.retry_policy.retry_delay_ms)).await;
        }
        *state.retry_selected = Some(selected);
        return Ok(());
    }
    state.failed_candidates.insert(candidate_key);
    *state.pending_provider_failure = Some(failure);
    Ok(())
}

fn payload_input_paired_call_ids(payload: &Value) -> Vec<String> {
    payload
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
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
                .map(str::to_owned)
        })
        .collect()
}

fn commit_or_release_responses_local_continuation(
    local: Option<&V3ResponsesRelayLocalContinuationExecution<'_>>,
    restored_context_ids: &[String],
    canonical_response: &Value,
    action: V3HubContinuationCommit,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(local) = local else {
        return Ok(());
    };
    let mut store = local.state.lock_store()?;
    commit_or_release_v3_relay_local_continuation_at_resp04(
        &mut store,
        local.scope.local_key(),
        local.now_epoch_ms,
        V3_RESPONSES_RELAY_LOCAL_CONTINUATION_TTL_MS,
        restored_context_ids,
        canonical_response,
        action,
    )?;
    Ok(())
}

#[derive(Debug)]
struct V3ResponsesRelayDryRunNoNetworkTransport {
    response_payload: Value,
    captured_provider_request: Arc<Mutex<Option<Value>>>,
}

#[async_trait::async_trait]
impl ResponsesTransport for V3ResponsesRelayDryRunNoNetworkTransport {
    async fn send(
        &self,
        request: routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest,
    ) -> Result<routecodex_v3_provider_responses::V3ProviderResp14Raw, V3ProviderError> {
        if let Ok(mut captured) = self.captured_provider_request.lock() {
            *captured = Some(request.redacted_provider_request_projection());
        }
        Ok(
            routecodex_v3_provider_responses::V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![routecodex_v3_provider_responses::V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                serde_json::to_vec(&self.response_payload).map_err(|error| {
                    V3ProviderError::ResponseBody {
                        request_id: request.request_id().to_string(),
                        provider_id: request.provider_id().to_string(),
                        reason: error.to_string(),
                    }
                })?,
            ),
        )
    }
}

pub async fn execute_v3_responses_relay_dry_run_runtime(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> crate::V3FoundationRuntimeOutput {
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3ResponsesRelayDryRunNoNetworkTransport {
        response_payload: json!({
            "id": format!("dry_run_{}", input.request_id),
            "object": "response",
            "status": "completed",
            "output_text": "routecodex provider-request dry-run stopped before provider send",
            "output": [{
                "type": "output_text",
                "text": "routecodex provider-request dry-run stopped before provider send"
            }]
        }),
        captured_provider_request: Arc::clone(&captured_provider_request),
    };
    let mut output = match execute_v3_responses_relay_runtime(manifest, input, &transport).await {
        Ok(output) => output,
        Err(error) => project_v3_responses_relay_runtime_failure(error),
    };
    if let Some(index) = output
        .node_trace
        .iter()
        .position(|node| *node == "V3ProviderReqOutbound09TransportRequest")
    {
        output
            .node_trace
            .insert(index + 1, "V3DryRunNoNetworkTerminalEffect");
    }
    output.node_trace.push("V3Server16HttpFrame");
    let provider_request = captured_provider_request
        .lock()
        .ok()
        .and_then(|captured| captured.clone())
        .unwrap_or(Value::Null);
    let response_payload = match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => value,
        V3ResponsesRelayClientBody::Sse(_) => json!({"body_kind": "sse_stream"}),
    };
    crate::V3FoundationRuntimeOutput {
        status: output.status,
        body: json!({
            "object": "routecodex.pipeline_dry_run",
            "kind": "provider_request",
            "dryRun": true,
            "evidence": {
                "stoppedBeforeProviderSend": true,
                "providerNetworkSend": false,
                "stoppedBeforeNetworkSend": true,
                "providerRequestCaptured": !provider_request.is_null()
            },
            "providerRequest": provider_request,
            "dry_run": {
                "fixture_id": "responses_relay_provider_request",
                "server_id": "responses_relay",
                "method": "POST",
                "path": "/v1/responses",
                "terminal_effect": "no_network_send",
                "provider_pipeline_executed": true,
                "provider_network_send": false,
                "stopped_before_network_send": true,
                "stopped_before_provider_send": true,
                "provider_request": provider_request,
                "node_ids": output.node_trace,
                "snapshots": [],
                "response_payload": response_payload
            }
        }),
        debug_node: "V3DryRunNoNetworkTerminalEffect",
        error_node: output
            .error_chain
            .as_ref()
            .map_or("none", |_| "V3Error06ClientProjected"),
        error_chain: output.error_chain.unwrap_or_default(),
        node_trace: output.node_trace,
        stopped_before_provider_send: true,
    }
}

pub fn project_v3_responses_relay_runtime_failure(
    error: V3ResponsesRelayRuntimeError,
) -> V3ResponsesRelayRuntimeOutput {
    match error {
        V3ResponsesRelayRuntimeError::Target(_) => {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::TargetPoolExhausted,
                "V3Target10ConcreteProviderSelected",
                "selected_target_exhausted",
                "all selected provider candidates are unavailable",
            );
            let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
            let local = build_v3_error_03_target_local_action_from_v3_error_02(
                classified,
                V3ErrorActionScope::None,
                0,
            );
            let exhausted = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(local, 0);
            let decision = build_v3_error_05_execution_decision_from_v3_error_04(exhausted);
            let projected = build_v3_error_06_client_projected_from_v3_error_05(decision);
            error_output(
                source,
                projected.status,
                projected.body,
                "none",
                Vec::new(),
                None,
                0,
            )
        }
        error => {
            let message = error.to_string();
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRuntime",
                "responses_relay_runtime_error",
                message.clone(),
            );
            error_output(
                source,
                500,
                json!({"error":{"type":"runtime_error","message":message}}),
                "none",
                Vec::new(),
                None,
                0,
            )
        }
    }
}

fn run_json_response_hooks(
    provider_value: &Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
) -> Result<(V3HubContinuationCommit, Value), V3ResponsesRelayRuntimeError> {
    let resp01 = build_v3_provider_resp_inbound_01_raw(
        provider_value.clone(),
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("V3HubRespInbound02Normalized");
    let resp03 = hooks.govern(resp02, &V3HubRelayResponseHookProfile::empty())?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    let action = resp04.action();
    let finalized_payload = resp04.finalized_payload().clone();
    trace.push("V3HubRespContinuation04Committed");
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok((action, finalized_payload))
}

fn push_streaming_response_trace(trace: &mut Vec<&'static str>) {
    trace.push("V3ProviderRespInbound01Raw");
    trace.push("V3HubRespInbound02Normalized");
    trace.push("V3HubRespChatProcess03Governed");
    trace.push("V3HubRespContinuation04Committed");
    trace.push("V3HubRespOutbound05ClientSemantic");
    trace.push("V3ServerRespOutbound06ClientFrame");
}

fn build_v3_relay_observability_from_selected(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    transport_intent: V3HubTransportIntent,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
        execution_mode: "relay".to_string(),
        transport: v3_transport_intent_label(transport_intent).to_string(),
        routing_group_id: Some(selected.route.routing_group_id.clone()),
        pool_id: Some(selected.route.pool_id.clone()),
        provider_id: Some(selected.candidate.provider_id.clone()),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        provider_key: Some(format!(
            "{}:{}:{}",
            selected.candidate.provider_id,
            selected.candidate.auth_alias,
            selected.candidate.model_id
        )),
        provider_type: Some(selected.candidate.provider_type.clone()),
        model_id: Some(selected.candidate.model_id.clone()),
        wire_model: Some(selected.candidate.wire_model.clone()),
        provider_status: None,
        response_status: None,
        attempts: Some(selected.attempts),
        unavailable_candidates: selected.unavailable_candidates.clone(),
        target_path: selected.candidate.path.clone(),
        usage: None,
    }
}

fn v3_transport_intent_label(intent: V3HubTransportIntent) -> &'static str {
    match intent {
        V3HubTransportIntent::Json => "json",
        V3HubTransportIntent::Sse => "sse",
    }
}

fn v3_responses_relay_now_epoch_ms() -> Result<u64, V3ResponsesRelayRuntimeError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderHealth(format!(
                "system time precedes Unix epoch: {error}"
            ))
        })
}

fn read_v3_runtime_response_status(value: &Value) -> Option<String> {
    value
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| !status.trim().is_empty())
        .map(str::to_string)
}

fn extract_v3_runtime_usage_summary(value: &Value) -> Option<V3RuntimeUsageSummary> {
    let usage = value.get("usage")?;
    let summary = V3RuntimeUsageSummary {
        input_tokens: read_v3_usage_u64(usage, &["input_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens"])),
        output_tokens: read_v3_usage_u64(usage, &["output_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["completion_tokens"])),
        total_tokens: read_v3_usage_u64(usage, &["total_tokens"]),
        cached_tokens: read_v3_usage_u64(usage, &["input_tokens_details", "cached_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["input_tokens_details", "cached_read_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["input_tokens_details", "cache_read_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens_details", "cached_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens_details", "cached_read_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens_details", "cache_read_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["cache_read_input_tokens"])),
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

fn read_v3_usage_u64(value: &Value, path: &[&str]) -> Option<u64> {
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

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: V3RuntimeStreamObservation,
) -> V3ResponsesRelayClientStream {
    use futures_util::{stream, StreamExt};

    Box::pin(stream::unfold(
        V3ObservedSseState {
            provider,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            observation,
            ready: VecDeque::new(),
            terminal_seen: false,
            done: false,
        },
        |mut state| async move {
            loop {
                if let Some(chunk) = state.ready.pop_front() {
                    return Some((Ok(chunk), state));
                }
                if state.done {
                    return None;
                }
                match state.provider.next().await {
                    Some(Ok(chunk)) => match observe_v3_runtime_sse_chunk(
                        &chunk,
                        &mut state.decoder,
                        &state.observation,
                    ) {
                        Ok(Some(_terminal)) => {
                            state.terminal_seen = true;
                            return Some((Ok(chunk), state));
                        }
                        Ok(None) => return Some((Ok(chunk), state)),
                        Err(error) => {
                            enqueue_v3_runtime_sse_failed_terminal(&mut state, &error);
                        }
                    },
                    Some(Err(error)) => {
                        if state.terminal_seen {
                            return None;
                        }
                        enqueue_v3_runtime_sse_failed_terminal(&mut state, &error.to_string());
                    }
                    None => {
                        let finish = std::mem::replace(
                            &mut state.decoder,
                            SseIncrementalDecoder::new(SseTransportLimits::default()),
                        )
                        .finish();
                        match finish {
                            Ok(()) if state.terminal_seen => return None,
                            Ok(()) => enqueue_v3_runtime_sse_failed_terminal(
                                &mut state,
                                V3_RESPONSES_RELAY_SSE_EOF_WITHOUT_TERMINAL_MESSAGE,
                            ),
                            Err(error) => enqueue_v3_runtime_sse_failed_terminal(
                                &mut state,
                                &error.to_string(),
                            ),
                        }
                    }
                }
            }
        },
    ))
}

fn enqueue_v3_runtime_sse_failed_terminal(state: &mut V3ObservedSseState, message: &str) {
    let event = build_v3_runtime_sse_failed_event(message);
    let _ = state.observation.record_event(&event);
    state
        .ready
        .push_back(build_v3_runtime_sse_json_frame("response.failed", &event));
    state.ready.push_back(b"data: [DONE]\n\n".to_vec());
    state.terminal_seen = true;
    state.done = true;
}

fn build_v3_runtime_sse_failed_event(message: &str) -> Value {
    json!({
        "type": "response.failed",
        "response": {
            "id": "resp_failed",
            "object": "response",
            "status": "failed",
            "model": "",
            "output": [],
            "error": {
                "code": "provider_response_sse_stream",
                "message": message,
                "type": "provider_error"
            }
        }
    })
}

fn build_v3_runtime_sse_json_frame(event: &str, payload: &Value) -> Vec<u8> {
    let data = serde_json::to_string(payload)
        .unwrap_or_else(|_| {
            format!(
                "{{\"type\":\"response.failed\",\"response\":{{\"status\":\"failed\",\"error\":{{\"code\":\"provider_response_sse_stream\",\"message\":\"{}\",\"type\":\"provider_error\"}}}}}}",
                V3_RESPONSES_RELAY_SSE_FAILED_MESSAGE
            )
        });
    format!("event: {event}\ndata: {data}\n\n").into_bytes()
}

fn observe_v3_runtime_sse_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    observation: &V3RuntimeStreamObservation,
) -> Result<Option<V3RuntimeSseTerminal>, String> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| error.to_string())?;
    let mut terminal = None;
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
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(data)
            .map_err(|error| format!("V3 Responses Relay SSE event is malformed: {error}"))?;
        observation.record_event(&event)?;
        let semantic_event_type = event_type
            .as_deref()
            .or_else(|| event.get("type").and_then(Value::as_str));
        match semantic_event_type {
            Some("response.completed" | "response.done") => {
                terminal = Some(V3RuntimeSseTerminal::Completed)
            }
            Some("response.failed" | "response.incomplete" | "response.error") => {
                terminal = Some(V3RuntimeSseTerminal::Failed)
            }
            _ => {}
        }
    }
    Ok(terminal)
}

fn resolve_target(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    body: &Value,
    request_local_excluded_candidates: &BTreeSet<String>,
    provider_health: &V3ProviderHealthStore,
    now_ms: u64,
) -> Result<routecodex_v3_target::V3Target10ConcreteProviderSelected, V3ResponsesRelayRuntimeError>
{
    let facts = crate::build_v3_router_request_facts_for_entry(body, "responses");
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(manifest, server_id, "/v1/responses", facts)
        .map_err(|error| V3ResponsesRelayRuntimeError::Target(format!("{error:?}")))?;
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .map_err(|error| V3ResponsesRelayRuntimeError::Target(format!("{error:?}")))?;
    let hit = router
        .hit_opaque_target_plan_once(plan, 0)
        .map_err(|error| V3ResponsesRelayRuntimeError::Target(format!("{error:?}")))?;
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    let expanded = target
        .expand_candidates(manifest, kind, 0)
        .map_err(|error| V3ResponsesRelayRuntimeError::Target(error.to_string()))?;
    target
        .select_available(
            expanded,
            &V3ResponsesRelayExcludedAvailability {
                base: V3ProviderAvailabilityRegistry::from_store(provider_health.clone()),
                excluded: request_local_excluded_candidates,
            },
            now_ms,
        )
        .map_err(|error| V3ResponsesRelayRuntimeError::Target(format!("{error:?}")))
}

fn v3_responses_relay_candidate_key(candidate: &routecodex_v3_target::V3TargetCandidate) -> String {
    v3_responses_relay_candidate_key_parts(
        &candidate.provider_id,
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

fn v3_responses_relay_candidate_key_parts(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or("-"),
        model_id.unwrap_or("-")
    )
}

fn provider_target(
    manifest: &V3Config05ManifestPublished,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3ResponsesProviderTarget, V3ResponsesRelayRuntimeError> {
    let provider = manifest
        .providers
        .get(&selected.provider_id)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::Target("selected provider missing".to_string())
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| entry.alias == selected.auth_alias)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::Target("selected auth handle missing".to_string())
        })?;
    let secret = match (&auth.env, &auth.token_file) {
        (Some(env), None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path)) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        _ => {
            return Err(V3ResponsesRelayRuntimeError::Target(
                "selected auth handle is invalid".to_string(),
            ))
        }
    };
    Ok(V3ResponsesProviderTarget {
        provider_id: selected.provider_id.clone(),
        provider_type: selected.provider_type.clone(),
        base_url: selected.base_url.clone(),
        canonical_model_id: selected.model_id.clone(),
        wire_model: selected.wire_model.clone(),
        auth: V3ProviderAuthHandle {
            alias: selected.auth_alias.clone(),
            secret,
        },
        responses_transport: selected.responses_transport,
        websocket_v2_url: selected.websocket_v2_url.clone(),
    })
}

fn server_routing_group(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Result<String, V3ResponsesRelayRuntimeError> {
    manifest
        .servers
        .get(server_id)
        .map(|server| server.routing_group.clone())
        .ok_or_else(|| V3ResponsesRelayRuntimeError::Target("server missing".to_string()))
}

fn provider_http_failure(
    status: u16,
    body: &[u8],
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    let body = serde_json::from_slice::<Value>(body)
        .unwrap_or_else(|_| json!({"error":{"type":"provider_error","message":"provider error"}}));
    V3ResponsesRelayProviderFailure {
        status,
        client_response: body,
        provider_id: provider_id.to_string(),
        observability,
    }
}

fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    V3ResponsesRelayProviderFailure {
        status: 502,
        client_response: json!({"error":{"type":"provider_error","message":error.to_string()}}),
        provider_id: provider_id.to_string(),
        observability,
    }
}

fn provider_failure_output(
    failure: V3ResponsesRelayProviderFailure,
    trace: Vec<&'static str>,
    candidates_remaining: usize,
) -> V3ResponsesRelayRuntimeOutput {
    let message = failure
        .client_response
        .pointer("/error/message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("provider returned HTTP {}", failure.status));
    let code = failure
        .client_response
        .pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/type")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if failure.status == 502 {
                "provider_transport_error".to_string()
            } else {
                format!("provider_http_{}", failure.status)
            }
        });
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        code,
        message,
    );
    error_output(
        source,
        failure.status,
        failure.client_response,
        &failure.provider_id,
        trace,
        failure.observability,
        candidates_remaining,
    )
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    client_response: Value,
    provider_id: &str,
    mut trace: Vec<&'static str>,
    mut observability: Option<V3RuntimeObservability>,
    candidates_remaining: usize,
) -> V3ResponsesRelayRuntimeOutput {
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let local = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        candidates_remaining,
    );
    let exhausted =
        build_v3_error_04_target_exhaustion_decision_from_v3_error_03(local, candidates_remaining);
    let decision = build_v3_error_05_execution_decision_from_v3_error_04(exhausted);
    let projected = build_v3_error_06_client_projected_from_v3_error_05(decision);
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    if let Some(observability) = observability.as_mut() {
        observability.response_status = Some("error".to_string());
        if observability.provider_status.is_none() {
            observability.provider_status = Some(status);
        }
        if observability.provider_id.is_none() && provider_id != "none" {
            observability.provider_id = Some(provider_id.to_string());
        }
    }
    V3ResponsesRelayRuntimeOutput {
        status,
        client_body: V3ResponsesRelayClientBody::Json(client_response),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability,
        stream_observation: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{stream, StreamExt};
    use serde_json::json;

    #[test]
    fn usage_summary_counts_cache_reads_but_not_cache_writes() {
        let summary = extract_v3_runtime_usage_summary(&json!({
            "usage": {
                "input_tokens": 59_842,
                "input_tokens_details": {
                    "cached_read_tokens": 41_984,
                    "cached_write_tokens": 7,
                    "cache_write_tokens": 11
                },
                "output_tokens": 822,
                "total_tokens": 60_664
            }
        }))
        .expect("usage summary");
        assert_eq!(summary.input_tokens, Some(59_842));
        assert_eq!(summary.cached_tokens, Some(41_984));
    }

    #[test]
    fn target_resolution_failure_projects_compact_target_exhaustion() {
        let output =
            project_v3_responses_relay_runtime_failure(V3ResponsesRelayRuntimeError::Target(
                "V3TargetExhaustion { route: internal debug state }".to_string(),
            ));

        assert_eq!(output.status, 503);
        let body = match &output.client_body {
            V3ResponsesRelayClientBody::Json(body) => body,
            V3ResponsesRelayClientBody::Sse(_) => panic!("target exhaustion must project as JSON"),
        };
        assert_eq!(body["error"]["code"], "selected_target_exhausted");
        assert_eq!(body["error"]["class"], "target_pool_exhausted");
        assert_eq!(body["error"]["target_exhausted"], true);
        assert_eq!(
            body["error"]["message"],
            "all selected provider candidates are unavailable"
        );
        assert!(!body.to_string().contains("V3TargetExhaustion"));
        assert_eq!(
            output.error_chain.as_deref(),
            Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
        );
    }

    #[test]
    fn non_target_runtime_failure_remains_runtime_error() {
        let output = project_v3_responses_relay_runtime_failure(
            V3ResponsesRelayRuntimeError::StaticRegistry("registry unavailable".to_string()),
        );

        assert_eq!(output.status, 500);
        let body = match &output.client_body {
            V3ResponsesRelayClientBody::Json(body) => body,
            V3ResponsesRelayClientBody::Sse(_) => panic!("runtime failure must project as JSON"),
        };
        assert_eq!(body["error"]["type"], "runtime_error");
        assert_eq!(
            body["error"]["message"],
            "V3 Hub static hook registry failed: registry unavailable"
        );
    }

    async fn collect_projected_sse(
        stream: V3ResponsesRelayClientStream,
    ) -> Vec<Result<String, String>> {
        stream
            .map(|item| {
                item.and_then(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
            })
            .collect()
            .await
    }

    #[tokio::test]
    async fn projected_sse_eof_without_terminal_emits_response_failed_then_done() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
        )]));
        let projected =
            collect_projected_sse(project_sse_stream(provider, observation.clone())).await;

        assert_eq!(projected.len(), 3);
        assert!(projected[0]
            .as_ref()
            .unwrap()
            .contains("response.output_text.delta"));
        assert!(projected[1].as_ref().unwrap().contains("response.failed"));
        assert!(projected[1]
            .as_ref()
            .unwrap()
            .contains("provider SSE stream ended before response.completed"));
        assert_eq!(projected[2].as_ref().unwrap(), "data: [DONE]\n\n");
        assert_eq!(
            observation.snapshot().unwrap().response_status.as_deref(),
            Some("failed")
        );
    }

    #[tokio::test]
    async fn projected_sse_provider_error_emits_response_failed_without_stream_err() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Err(V3ProviderError::ResponseBody {
            request_id: "req".to_string(),
            provider_id: "upstream".to_string(),
            reason: "read failed".to_string(),
        })]));
        let projected =
            collect_projected_sse(project_sse_stream(provider, observation.clone())).await;

        assert_eq!(projected.len(), 2);
        assert!(projected.iter().all(Result::is_ok));
        assert!(projected[0].as_ref().unwrap().contains("response.failed"));
        assert!(projected[0].as_ref().unwrap().contains("read failed"));
        assert_eq!(projected[1].as_ref().unwrap(), "data: [DONE]\n\n");
        assert_eq!(
            observation.snapshot().unwrap().response_status.as_deref(),
            Some("failed")
        );
    }

    #[tokio::test]
    async fn projected_sse_completed_terminal_closes_without_synthetic_failure() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n".to_vec(),
        )]));
        let projected =
            collect_projected_sse(project_sse_stream(provider, observation.clone())).await;

        assert_eq!(projected.len(), 1);
        assert!(projected[0]
            .as_ref()
            .unwrap()
            .contains("response.completed"));
        let snapshot = observation.snapshot().unwrap();
        assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
        assert_eq!(
            snapshot.usage.as_ref().and_then(|usage| usage.total_tokens),
            Some(3)
        );
    }
}
