use super::*;
use crate::V3LocalContinuationReq04RestoreRequest;
use futures_util::StreamExt;
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
    build_v3_transport_13_responses_http_request_from_parts,
    build_v3_transport_13_responses_http_request_from_v3_provider_12, ReqwestResponsesTransport,
    ResponsesTransport, V3Provider12ResponsesWirePayload, V3ProviderAuthHandle,
    V3ProviderAuthSecretHandle, V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader,
    V3ProviderAvailabilityRegistry, V3ProviderError, V3ProviderHealthStore, V3ProviderResp14Raw,
    V3ProviderResponseBody, V3ProviderResponseHeader, V3ResponsesProviderTarget,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const V3_RESPONSES_RELAY_LOCAL_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;
const V3_RESPONSES_RELAY_SSE_EOF_WITHOUT_TERMINAL_MESSAGE: &str =
    "provider SSE stream ended before response.completed";
const V3_RESPONSES_RELAY_SSE_FAILED_MESSAGE: &str =
    "provider SSE stream failed before response.completed";
const V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER: &str =
    "ProviderRespInbound01Raw -> V3HubRespInbound02Normalized (Responses event codec; SSE transport is opaque framing)";
const V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER: &str =
    "V3HubRespOutbound05ClientSemantic -> V3ServerRespOutbound06ClientFrame";
const V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_COUNT: usize = 3;
const V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_DELAY_MS: u64 = 5_000;

pub type V3ResponsesRelayClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

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
    pub provider_snapshots: Option<V3ResponsesRelayProviderSnapshots>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct V3ResponsesRelayProviderSnapshots {
    pub provider_request: Option<Value>,
    pub provider_response: Option<Value>,
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
    pub finish_reason: Option<String>,
    pub stopless_activation: bool,
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
    pub finish_reason: Option<String>,
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

#[derive(Debug, Clone)]
pub struct V3ResponsesRelayProviderHealthHandle {
    store: V3ProviderHealthStore,
}

impl V3ResponsesRelayProviderHealthHandle {
    pub fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest(manifest),
        }
    }

    pub fn store(&self) -> V3ProviderHealthStore {
        self.store.clone()
    }
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
        let finish_reason = read_v3_runtime_finish_reason(semantic)
            .or_else(|| read_v3_runtime_finish_reason(event));
        if response_status.is_none() && finish_reason.is_none() && usage.is_none() {
            return Ok(());
        }
        let mut snapshot = self
            .inner
            .lock()
            .map_err(|_| "V3 runtime stream observation state lock is poisoned".to_string())?;
        if response_status.is_some() {
            snapshot.response_status = response_status;
        }
        if let Some(finish_reason) = finish_reason {
            if finish_reason == "tool_calls"
                || snapshot.finish_reason.as_deref() != Some("tool_calls")
            {
                snapshot.finish_reason = Some(finish_reason);
            }
        }
        if usage.is_some() {
            snapshot.usage = usage;
        }
        Ok(())
    }

    fn record_finish_reason(&self, finish_reason: &str) -> Result<(), String> {
        let finish_reason = finish_reason.trim();
        if finish_reason.is_empty() {
            return Ok(());
        }
        let mut snapshot = self
            .inner
            .lock()
            .map_err(|_| "V3 runtime stream observation state lock is poisoned".to_string())?;
        snapshot.finish_reason = Some(finish_reason.to_string());
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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ResponsesRelayStoplessControlKey {
    entry_endpoint: String,
    session_id: String,
    conversation_id: String,
    port: u16,
    routing_group: String,
}

impl From<&V3ResponsesRelayLocalContinuationScope> for V3ResponsesRelayStoplessControlKey {
    fn from(scope: &V3ResponsesRelayLocalContinuationScope) -> Self {
        Self {
            entry_endpoint: scope.entry_endpoint.clone(),
            session_id: scope.session_id.clone(),
            conversation_id: scope.conversation_id.clone(),
            port: scope.port,
            routing_group: scope.routing_group.clone(),
        }
    }
}

#[derive(Debug, Default)]
pub struct V3ResponsesRelayStoplessControlState {
    store: Mutex<BTreeMap<V3ResponsesRelayStoplessControlKey, V3StoplessCenterState>>,
}

impl V3ResponsesRelayStoplessControlState {
    pub fn len(&self) -> Result<usize, V3ResponsesRelayRuntimeError> {
        Ok(self.lock_store()?.len())
    }

    pub fn is_empty(&self) -> Result<bool, V3ResponsesRelayRuntimeError> {
        Ok(self.lock_store()?.is_empty())
    }

    pub fn load_for_scope(
        &self,
        scope: &V3ResponsesRelayLocalContinuationScope,
    ) -> Result<Option<V3StoplessCenterState>, V3ResponsesRelayRuntimeError> {
        Ok(self
            .lock_store()?
            .get(&V3ResponsesRelayStoplessControlKey::from(scope))
            .cloned())
    }

    pub fn store_for_scope(
        &self,
        scope: &V3ResponsesRelayLocalContinuationScope,
        state: V3StoplessCenterState,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.lock_store()?
            .insert(V3ResponsesRelayStoplessControlKey::from(scope), state);
        Ok(())
    }

    pub fn clear_for_scope(
        &self,
        scope: &V3ResponsesRelayLocalContinuationScope,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.lock_store()?
            .remove(&V3ResponsesRelayStoplessControlKey::from(scope));
        Ok(())
    }

    fn lock_store(
        &self,
    ) -> Result<
        MutexGuard<'_, BTreeMap<V3ResponsesRelayStoplessControlKey, V3StoplessCenterState>>,
        V3ResponsesRelayRuntimeError,
    > {
        self.store
            .lock()
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }
}

#[derive(Clone)]
struct V3LiveSnapResponsesTransport<T> {
    inner: T,
    snapshots: V3LiveSnapProviderSnapshotRecorder,
}

impl V3LiveSnapResponsesTransport<ReqwestResponsesTransport> {
    fn with_default_transport() -> Self {
        Self {
            inner: ReqwestResponsesTransport::default(),
            snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
        }
    }
}

impl<T> V3LiveSnapResponsesTransport<T> {
    fn snapshots(&self) -> V3LiveSnapProviderSnapshotRecorder {
        self.snapshots.clone()
    }
}

#[async_trait::async_trait]
impl<T> ResponsesTransport for V3LiveSnapResponsesTransport<T>
where
    T: ResponsesTransport,
{
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let attempt = self.snapshots.record_provider_request(&request)?;
        let result = self.inner.send(request).await;
        match result {
            Ok(raw) => self.snapshots.record_provider_response(attempt, raw),
            Err(error) => {
                self.snapshots.record_provider_error(attempt, &error)?;
                Err(error)
            }
        }
    }
}

#[derive(Clone, Default)]
struct V3LiveSnapProviderSnapshotRecorder {
    inner: Arc<Mutex<V3LiveSnapProviderSnapshotState>>,
}

#[derive(Default)]
struct V3LiveSnapProviderSnapshotState {
    requests: Vec<Value>,
    responses: Vec<Value>,
}

impl V3LiveSnapProviderSnapshotRecorder {
    fn record_provider_request(
        &self,
        request: &V3Transport13ResponsesHttpRequest,
    ) -> Result<usize, V3ProviderError> {
        let mut state = self.inner.lock().map_err(|_| V3ProviderError::Transport {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
            reason: "V3 live snap provider request recorder lock is poisoned".to_string(),
        })?;
        let attempt = state.requests.len() + 1;
        state.requests.push(json!({
            "attempt": attempt,
            "request": request.redacted_provider_request_projection(),
        }));
        Ok(attempt)
    }

    fn record_provider_response(
        &self,
        attempt: usize,
        raw: V3ProviderResp14Raw,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let request_id = raw.request_id().to_string();
        let provider_id = raw.provider_id().to_string();
        let status = raw.status();
        let headers = raw.headers().to_vec();
        match raw.into_body() {
            V3ProviderResponseBody::Json(bytes) => {
                self.record_json_provider_response(
                    attempt,
                    &request_id,
                    &provider_id,
                    status,
                    &headers,
                    &bytes,
                )?;
                Ok(V3ProviderResp14Raw::from_json(
                    request_id,
                    provider_id,
                    status,
                    headers,
                    bytes,
                ))
            }
            V3ProviderResponseBody::Sse(stream) => {
                self.record_sse_provider_response_start(
                    attempt,
                    &request_id,
                    &provider_id,
                    status,
                    &headers,
                )?;
                let recorder = self.clone();
                let stream_request_id = request_id.clone();
                let stream_provider_id = provider_id.clone();
                let captured_stream = stream.map(move |chunk| match chunk {
                    Ok(bytes) => recorder
                        .append_sse_provider_response_chunk(
                            attempt,
                            &stream_request_id,
                            &stream_provider_id,
                            &bytes,
                        )
                        .map(|_| bytes),
                    Err(error) => recorder
                        .record_sse_provider_response_error(
                            attempt,
                            &stream_request_id,
                            &stream_provider_id,
                            &error,
                        )
                        .and(Err(error)),
                });
                Ok(V3ProviderResp14Raw::from_sse(
                    request_id,
                    provider_id,
                    status,
                    headers,
                    Box::pin(captured_stream),
                ))
            }
        }
    }

    fn record_provider_error(
        &self,
        attempt: usize,
        error: &V3ProviderError,
    ) -> Result<(), V3ProviderError> {
        match error {
            V3ProviderError::HttpStatus { response } => self.record_json_provider_response(
                attempt,
                &response.request_id,
                &response.provider_id,
                response.status,
                &response.headers,
                &response.body,
            ),
            V3ProviderError::Transport {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::WebSocketTransport {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::WebSocketProtocol {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::WebSocketProviderEvent {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::UnexpectedContentType {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::ResponseBody {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::MalformedSse {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::ClientDisconnect {
                request_id,
                provider_id,
            } => self.record_transport_provider_error(attempt, request_id, provider_id, error),
            V3ProviderError::InvalidWireBody { request_id }
            | V3ProviderError::InvalidStreamIntent { request_id } => {
                self.record_transport_provider_error(attempt, request_id, "unknown", error)
            }
            V3ProviderError::InvalidBaseUrl {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::MissingAuthSecret {
                request_id,
                provider_id,
                ..
            }
            | V3ProviderError::AuthSecretRead {
                request_id,
                provider_id,
                ..
            } => self.record_transport_provider_error(attempt, request_id, provider_id, error),
        }
    }

    fn record_json_provider_response(
        &self,
        attempt: usize,
        request_id: &str,
        provider_id: &str,
        status: u16,
        headers: &[V3ProviderResponseHeader],
        body: &[u8],
    ) -> Result<(), V3ProviderError> {
        let mut state = self.inner.lock().map_err(|_| V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "V3 live snap provider response recorder lock is poisoned".to_string(),
        })?;
        state.responses.push(json!({
            "attempt": attempt,
            "response": {
                "requestId": request_id,
                "providerId": provider_id,
                "status": status,
                "headers": project_v3_provider_response_headers(headers),
                "bodyKind": "json",
                "body": project_v3_provider_response_body(body),
            }
        }));
        Ok(())
    }

    fn record_sse_provider_response_start(
        &self,
        attempt: usize,
        request_id: &str,
        provider_id: &str,
        status: u16,
        headers: &[V3ProviderResponseHeader],
    ) -> Result<(), V3ProviderError> {
        let mut state = self.inner.lock().map_err(|_| V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "V3 live snap provider response recorder lock is poisoned".to_string(),
        })?;
        state.responses.push(json!({
            "attempt": attempt,
            "response": {
                "requestId": request_id,
                "providerId": provider_id,
                "status": status,
                "headers": project_v3_provider_response_headers(headers),
                "bodyKind": "sse",
                "rawSse": "",
            }
        }));
        Ok(())
    }

    fn append_sse_provider_response_chunk(
        &self,
        attempt: usize,
        request_id: &str,
        provider_id: &str,
        chunk: &[u8],
    ) -> Result<(), V3ProviderError> {
        let mut state = self.inner.lock().map_err(|_| V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "V3 live snap provider response recorder lock is poisoned".to_string(),
        })?;
        let Some(Value::String(raw_sse)) = state
            .responses
            .iter_mut()
            .rev()
            .find(|entry| entry.get("attempt").and_then(Value::as_u64) == Some(attempt as u64))
            .and_then(|entry| entry.pointer_mut("/response/rawSse"))
        else {
            return Err(V3ProviderError::Transport {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                reason: format!(
                    "V3 live snap provider SSE response attempt {attempt} was not initialized"
                ),
            });
        };
        raw_sse.push_str(&String::from_utf8_lossy(chunk));
        Ok(())
    }

    fn record_sse_provider_response_error(
        &self,
        attempt: usize,
        request_id: &str,
        provider_id: &str,
        error: &V3ProviderError,
    ) -> Result<(), V3ProviderError> {
        let mut state = self.inner.lock().map_err(|_| V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "V3 live snap provider response recorder lock is poisoned".to_string(),
        })?;
        let Some(entry) = state
            .responses
            .iter_mut()
            .rev()
            .find(|entry| entry.get("attempt").and_then(Value::as_u64) == Some(attempt as u64))
        else {
            return Err(V3ProviderError::Transport {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                reason: format!(
                    "V3 live snap provider SSE response attempt {attempt} was not initialized"
                ),
            });
        };
        if let Some(response) = entry.get_mut("response").and_then(Value::as_object_mut) {
            response.insert("streamError".to_string(), Value::String(error.to_string()));
        }
        Ok(())
    }

    fn record_transport_provider_error(
        &self,
        attempt: usize,
        request_id: &str,
        provider_id: &str,
        error: &V3ProviderError,
    ) -> Result<(), V3ProviderError> {
        let mut state = self.inner.lock().map_err(|_| V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "V3 live snap provider response recorder lock is poisoned".to_string(),
        })?;
        state.responses.push(json!({
            "attempt": attempt,
            "response": {
                "requestId": request_id,
                "providerId": provider_id,
                "bodyKind": "transport_error",
                "error": error.to_string(),
            }
        }));
        Ok(())
    }

    fn provider_request_payload(&self) -> Option<Value> {
        let state = self.inner.lock().ok()?;
        if state.requests.is_empty() {
            return None;
        }
        Some(json!({
            "object": "routecodex.v3.provider_request_snapshots",
            "stage": "provider-request",
            "source": "runtime_provider_transport_cutpoint",
            "attempts": state.requests.clone(),
        }))
    }

    fn provider_response_payload(&self) -> Option<Value> {
        let state = self.inner.lock().ok()?;
        if state.responses.is_empty() {
            return None;
        }
        Some(json!({
            "object": "routecodex.v3.provider_response_snapshots",
            "stage": "provider-response",
            "source": "runtime_provider_transport_cutpoint",
            "attempts": state.responses.clone(),
        }))
    }

    fn into_payload(
        self,
        capture_provider_request: bool,
        capture_provider_response: bool,
    ) -> V3ResponsesRelayProviderSnapshots {
        V3ResponsesRelayProviderSnapshots {
            provider_request: capture_provider_request
                .then(|| self.provider_request_payload())
                .flatten(),
            provider_response: capture_provider_response
                .then(|| self.provider_response_payload())
                .flatten(),
        }
    }

    #[cfg(test)]
    fn provider_response_payload_for_selector(&self, selector: &str) -> Option<Value> {
        if routecodex_v3_debug::should_capture_v3_snapshot_stage(
            Some(selector),
            "provider-response",
        ) {
            self.provider_response_payload()
        } else {
            None
        }
    }
}

fn project_v3_provider_response_headers(headers: &[V3ProviderResponseHeader]) -> Value {
    Value::Array(
        headers
            .iter()
            .map(|header| {
                json!({
                    "name": header.name,
                    "value": String::from_utf8_lossy(&header.value).to_string(),
                })
            })
            .collect(),
    )
}

fn project_v3_provider_response_body(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or_else(|_| {
        json!({
            "rawText": String::from_utf8_lossy(body).to_string(),
        })
    })
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
    #[error("V3 Responses Relay provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 Responses Relay provider health failed: {0}")]
    ProviderHealth(String),
    #[error("V3 Responses Relay JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 Responses Relay SSE provider body is malformed: {0}")]
    ProviderSse(String),
    #[error(transparent)]
    LocalContinuation(#[from] V3LocalContinuationError),
    #[error("V3 Responses Relay local continuation scope routing group does not match server")]
    LocalContinuationScopeMismatch,
    #[error("V3 Responses Relay local continuation state lock is poisoned")]
    LocalContinuationStatePoisoned,
    #[error("V3 Responses Relay stopless runtime_control state lock is poisoned")]
    StoplessControlStatePoisoned,
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
    provider_health: &V3ResponsesRelayProviderHealthHandle,
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
            commit_resp04_effects: true,
            stopless_control: None,
        }),
        provider_health.store.clone(),
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_transport_health_and_local_continuation<
    T: ResponsesTransport,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    state: &V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: true,
            stopless_control: None,
        }),
        provider_health.store.clone(),
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control<
    T: ResponsesTransport,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: true,
            stopless_control: Some(stopless_control),
        }),
        provider_health.store.clone(),
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
        state,
        stopless_control,
        scope,
        now_epoch_ms,
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    capture_provider_request: bool,
    capture_provider_response: bool,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let transport = V3LiveSnapResponsesTransport::with_default_transport();
    let snapshots = transport.snapshots();
    let mut output =
        execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
            manifest,
            input,
            &transport,
            provider_health,
            state,
            stopless_control,
            scope,
            now_epoch_ms,
        )
        .await?;
    output.provider_snapshots =
        Some(snapshots.into_payload(capture_provider_request, capture_provider_response));
    Ok(output)
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
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(manifest);
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        None,
        provider_health.store,
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
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    retry_policy: V3ResponsesRelayRetryPolicy,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        None,
        provider_health.store.clone(),
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
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(manifest);
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: true,
            stopless_control: None,
        }),
        provider_health.store,
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

struct V3ResponsesRelayLocalContinuationExecution<'state> {
    state: &'state V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    commit_resp04_effects: bool,
    stopless_control: Option<&'state V3ResponsesRelayStoplessControlState>,
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
    let mut trace = Vec::with_capacity(17);
    let transport_intent = if input.payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let local_tool_output_ids = find_responses_tool_output_ids(&input.payload)?;
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
    let lookup = if let (Some(local), Some(context_id)) =
        (local.as_ref(), local_tool_output_ids.restore_ids.first())
    {
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
        for additional_id in local_tool_output_ids.restore_ids.iter().skip(1) {
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
        V3HubContinuationLookup::new(Some(context_id), local.scope.hub_scope(&input.server_id))
            .with_local_context(context_id, local.scope.hub_scope(&input.server_id), context)
    } else {
        V3HubContinuationLookup::new(None, base_hub_scope)
    };
    let request_stopless_control_state =
        load_v3_responses_relay_stopless_control_state(manifest, local.as_ref())?;
    let request_hook_profile =
        responses_relay_request_hook_profile(manifest, request_stopless_control_state.as_ref());
    let request_outcome = compile_v3_hub_relay_request_hooks().run_from_normalized(
        req02,
        &lookup,
        &request_hook_profile,
    )?;
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let stopless_state = request_outcome.stopless_state().cloned();
    if stopless_state.is_none() && request_stopless_control_state.is_some() {
        clear_v3_responses_relay_stopless_control_state(manifest, local.as_ref())?;
    }
    let provider_semantic_body = request_outcome.payload().clone();
    let req04 = request_outcome.into_governed();
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
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
        let provider_wire_protocol =
            provider_wire_protocol_for_selected_candidate(&selected.candidate)?;
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target())?;
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)?;
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = _req09.into_provider_semantic_payload();
        let wire = build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        )?;
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request =
            build_v3_provider_transport_request_for_protocol(provider_wire_protocol, wire)?;
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
                let (action, finalized_provider_value, response_stopless_state) =
                    run_json_response_hooks(
                        &provider_value,
                        &provider_semantic_body,
                        manifest,
                        provider_wire_protocol,
                        transport_intent,
                        &mut trace,
                        selected.candidate.compatibility_profile.as_deref(),
                        stopless_state.as_ref(),
                    )?;
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    local.as_ref(),
                    response_stopless_state,
                )?;
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    &provider_semantic_body,
                    &finalized_provider_value,
                    action,
                )?;
                let mut observability = selected_observability;
                observability.provider_status = Some(provider_status);
                observability.provider_id = Some(provider_id);
                observability.transport = "json".to_string();
                let response_status = read_v3_runtime_response_status(&finalized_provider_value);
                observability.finish_reason =
                    read_v3_runtime_finish_reason(&finalized_provider_value)
                        .or_else(|| read_v3_runtime_finish_reason(&provider_value))
                        .or_else(|| {
                            infer_v3_runtime_finish_reason(action, response_status.as_deref())
                        });
                observability.response_status = response_status;
                observability.usage = extract_v3_runtime_usage_summary(&finalized_provider_value);
                observability.stopless_activation =
                    response_has_stopless_activation(&finalized_provider_value);
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body: V3ResponsesRelayClientBody::Json(finalized_provider_value),
                    node_trace: trace,
                    error_chain: None,
                    observability: Some(observability),
                    stream_observation: None,
                    provider_snapshots: None,
                });
            }
            V3ProviderResponseBody::Sse(stream) => {
                let stream_observation = V3RuntimeStreamObservation::default();
                let provider_value =
                    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
                        provider_wire_protocol,
                        stream,
                        &stream_observation,
                    )
                    .await?;
                let (action, finalized_provider_value, response_stopless_state) =
                    run_json_response_hooks(
                        &provider_value,
                        &provider_semantic_body,
                        manifest,
                        provider_wire_protocol,
                        transport_intent,
                        &mut trace,
                        selected.candidate.compatibility_profile.as_deref(),
                        stopless_state.as_ref(),
                    )?;
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    local.as_ref(),
                    response_stopless_state,
                )?;
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    &provider_semantic_body,
                    &finalized_provider_value,
                    action,
                )?;
                stream_observation
                    .record_event(&json!({
                        "type":"response.completed",
                        "response": finalized_provider_value.clone()
                    }))
                    .map_err(V3ResponsesRelayRuntimeError::ProviderSse)?;
                let mut observability = selected_observability;
                observability.provider_status = Some(provider_status);
                observability.provider_id = Some(provider_id);
                observability.transport = "sse".to_string();
                let response_status = read_v3_runtime_response_status(&finalized_provider_value);
                observability.finish_reason =
                    read_v3_runtime_finish_reason(&finalized_provider_value)
                        .or_else(|| read_v3_runtime_finish_reason(&provider_value))
                        .or_else(|| {
                            stream_observation
                                .snapshot()
                                .ok()
                                .and_then(|snapshot| snapshot.finish_reason)
                        })
                        .or_else(|| {
                            infer_v3_runtime_finish_reason(action, response_status.as_deref())
                        });
                if let Some(finish_reason) = observability.finish_reason.as_deref() {
                    stream_observation
                        .record_finish_reason(finish_reason)
                        .map_err(V3ResponsesRelayRuntimeError::ProviderSse)?;
                }
                observability.response_status = response_status;
                observability.usage = extract_v3_runtime_usage_summary(&finalized_provider_value)
                    .or_else(|| extract_v3_runtime_usage_summary(&provider_value))
                    .or_else(|| {
                        stream_observation
                            .snapshot()
                            .ok()
                            .and_then(|snapshot| snapshot.usage)
                    });
                observability.stopless_activation =
                    response_has_stopless_activation(&finalized_provider_value);
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body: V3ResponsesRelayClientBody::Sse(
                        build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(
                            finalized_provider_value,
                        ),
                    ),
                    node_trace: trace,
                    error_chain: None,
                    observability: Some(observability),
                    stream_observation: Some(stream_observation),
                    provider_snapshots: None,
                });
            }
        }
    }
}

fn provider_wire_protocol_for_selected_candidate(
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3HubProviderWireProtocol, V3ResponsesRelayRuntimeError> {
    match selected.provider_type.trim() {
        "responses" | "openai_responses" | "openai-responses" => {
            Ok(V3HubProviderWireProtocol::Responses)
        }
        "openai_chat" | "openai-chat" | "openai_chat_completions" | "openai-chat-completions" => {
            Ok(V3HubProviderWireProtocol::OpenAiChat)
        }
        other => Err(V3ResponsesRelayRuntimeError::Target(format!(
            "Responses relay selected unsupported provider wire protocol: provider={} type={other}",
            selected.provider_id
        ))),
    }
}

fn build_v3_provider_transport_request_for_protocol(
    provider_protocol: V3HubProviderWireProtocol,
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3ResponsesRelayRuntimeError> {
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)
                .map_err(V3ResponsesRelayRuntimeError::Provider)
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_transport_request_from_v3_provider_08(wire)
        }
        other => Err(V3ResponsesRelayRuntimeError::Target(format!(
            "Responses relay does not support provider transport protocol {other:?}"
        ))),
    }
}

fn build_v3_openai_chat_transport_request_from_v3_provider_08(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3ResponsesRelayRuntimeError> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let stream_intent = wire.stream_intent();
    let body = wire.body().clone();
    let url_text = format!("{}/chat/completions", target.base_url.trim_end_matches('/'));
    build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
    )
    .map_err(|error| V3ResponsesRelayRuntimeError::Target(error.to_string()))
}

#[derive(Debug, Default)]
struct V3ResponsesRelayToolOutputIds {
    restore_ids: Vec<String>,
    consumed_ids: Vec<String>,
}

fn find_responses_tool_output_ids(
    payload: &Value,
) -> Result<V3ResponsesRelayToolOutputIds, V3ResponsesRelayRuntimeError> {
    let paired_call_ids = payload_input_paired_call_ids(payload);
    let mut ids = V3ResponsesRelayToolOutputIds::default();
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
            .or_else(|| item.get("tool_call_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Responses tool output requires call_id".to_string(),
            })?;
        if !ids.consumed_ids.iter().any(|existing| existing == id) {
            ids.consumed_ids.push(id.to_owned());
        }
        if paired_call_ids.iter().any(|paired| paired == id) {
            continue;
        }
        if !ids.restore_ids.iter().any(|existing| existing == id) {
            ids.restore_ids.push(id.to_owned());
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
    canonical_request: &Value,
    canonical_response: &Value,
    action: V3HubContinuationCommit,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(local) = local else {
        return Ok(());
    };
    if !local.commit_resp04_effects {
        return Ok(());
    }
    let canonical_context = if action == V3HubContinuationCommit::LocalContext {
        build_v3_relay_local_continuation_context_at_resp04(canonical_request, canonical_response)?
    } else {
        canonical_response.clone()
    };
    let mut store = local.state.lock_store()?;
    commit_or_release_v3_relay_local_continuation_at_resp04(
        &mut store,
        local.scope.local_key(),
        local.now_epoch_ms,
        V3_RESPONSES_RELAY_LOCAL_CONTINUATION_TTL_MS,
        restored_context_ids,
        &canonical_context,
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
    execute_v3_responses_relay_dry_run_runtime_inner(manifest, input, None).await
}

pub async fn execute_v3_responses_relay_dry_run_runtime_with_local_continuation(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: false,
            stopless_control: None,
        }),
    )
    .await
}

pub async fn execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: false,
            stopless_control: Some(stopless_control),
        }),
    )
    .await
}

async fn execute_v3_responses_relay_dry_run_runtime_inner(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
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
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(manifest);
    let mut output = match execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        &transport,
        local,
        provider_health.store,
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
    {
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
    let dry_run_status = if provider_request.is_null() {
        output.status
    } else {
        200
    };
    let response_payload = match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => value,
        V3ResponsesRelayClientBody::Sse(_) => json!({"body_kind": "sse_stream"}),
    };
    crate::V3FoundationRuntimeOutput {
        status: dry_run_status,
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
    provider_semantic_body: &Value,
    manifest: &V3Config05ManifestPublished,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
    stopless_state: Option<&V3StoplessCenterState>,
) -> Result<
    (
        V3HubContinuationCommit,
        Value,
        Option<V3StoplessCenterState>,
    ),
    V3ResponsesRelayRuntimeError,
> {
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        provider_value.clone(),
        V3HubEntryProtocol::Responses,
        provider_protocol,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport_intent,
        compatibility_profile,
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let mut resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    if provider_protocol == V3HubProviderWireProtocol::OpenAiChat {
        let converted = build_v3_responses_provider_response_from_openai_chat_payload(
            resp02.provider_payload(),
            provider_semantic_body,
        )?;
        *resp02.provider_payload_mut() = Arc::new(converted);
        resp02.provider_raw_mut().provider_protocol = V3HubProviderWireProtocol::Responses;
    }
    trace.push("V3HubRespInbound02Normalized");
    let response_hook_profile = responses_relay_response_hook_profile(manifest, stopless_state);
    let resp03 = hooks.govern(resp02, &response_hook_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    let action = resp04.action();
    let finalized_payload = resp04.finalized_payload().clone();
    let response_stopless_state = resp04.stopless_center_state().cloned();
    trace.push("V3HubRespContinuation04Committed");
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    trace.push("V3HubRespOutbound05ClientSemantic");
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok((action, finalized_payload, response_stopless_state))
}

fn responses_relay_request_hook_profile(
    manifest: &V3Config05ManifestPublished,
    stopless_state: Option<&V3StoplessCenterState>,
) -> V3HubServertoolRequestProfile {
    if !v3_stopless_center_enabled(manifest) {
        return V3HubServertoolRequestProfile::disabled();
    }
    let profile = V3HubServertoolRequestProfile::stopless_reasoning_stop();
    match stopless_state {
        Some(state) => profile.with_stopless_center_state(state.clone()),
        None => profile,
    }
}

fn responses_relay_response_hook_profile(
    manifest: &V3Config05ManifestPublished,
    stopless_state: Option<&V3StoplessCenterState>,
) -> V3HubRelayResponseHookProfile {
    if !v3_stopless_center_enabled(manifest) {
        return V3HubRelayResponseHookProfile::empty();
    }
    let profile = V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop();
    match stopless_state {
        Some(state) => profile.with_stopless_center_state(state.clone()),
        None => profile,
    }
}

fn v3_stopless_center_enabled(manifest: &V3Config05ManifestPublished) -> bool {
    manifest
        .features
        .get("stopless_center")
        .copied()
        .unwrap_or(true)
}

fn load_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    local: Option<&V3ResponsesRelayLocalContinuationExecution<'_>>,
) -> Result<Option<V3StoplessCenterState>, V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled(manifest) {
        return Ok(None);
    }
    let Some(local) = local else {
        return Ok(None);
    };
    let Some(control) = local.stopless_control else {
        return Ok(None);
    };
    control.load_for_scope(&local.scope)
}

fn store_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    local: Option<&V3ResponsesRelayLocalContinuationExecution<'_>>,
    state: V3StoplessCenterState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled(manifest) {
        return Ok(());
    }
    let Some(local) = local else {
        return Ok(());
    };
    let Some(control) = local.stopless_control else {
        return Ok(());
    };
    control.store_for_scope(&local.scope, state)
}

fn clear_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    local: Option<&V3ResponsesRelayLocalContinuationExecution<'_>>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled(manifest) {
        return Ok(());
    }
    let Some(local) = local else {
        return Ok(());
    };
    let Some(control) = local.stopless_control else {
        return Ok(());
    };
    control.clear_for_scope(&local.scope)
}

fn apply_v3_responses_relay_stopless_control_transition(
    manifest: &V3Config05ManifestPublished,
    local: Option<&V3ResponsesRelayLocalContinuationExecution<'_>>,
    response_stopless_state: Option<V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    match response_stopless_state {
        Some(state) => store_v3_responses_relay_stopless_control_state(manifest, local, state),
        None => clear_v3_responses_relay_stopless_control_state(manifest, local),
    }
}

fn build_v3_responses_provider_response_from_openai_chat_payload(
    payload: &Value,
    provider_semantic_body: &Value,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderSse(
                "OpenAI Chat provider response must contain choices before Responses projection"
                    .to_string(),
            )
        })?;
    let mut output = Vec::new();
    let mut output_text_parts = Vec::new();
    let mut finish_reason = None;
    let custom_tool_names = collect_v3_responses_custom_tool_names(provider_semantic_body);
    for choice in choices {
        if finish_reason.is_none() {
            finish_reason = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(message) = choice.get("message").and_then(Value::as_object) {
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                if !content.trim().is_empty() {
                    output_text_parts.push(content.to_string());
                    output.push(json!({"type":"output_text","text":content}));
                }
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    output.push(build_v3_responses_function_call_from_openai_chat_tool_call(
                        call,
                        &custom_tool_names,
                    )?);
                }
            }
        }
    }
    let status = if output.iter().any(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call" | "tool_call" | "custom_tool_call")
        )
    }) || finish_reason.as_deref() == Some("tool_calls")
    {
        "requires_action"
    } else {
        "completed"
    };
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        payload
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::String("resp_openai_chat_relay".to_string())),
    );
    response.insert("object".to_string(), Value::String("response".to_string()));
    response.insert("status".to_string(), Value::String(status.to_string()));
    response.insert("output".to_string(), Value::Array(output));
    if !output_text_parts.is_empty() {
        response.insert(
            "output_text".to_string(),
            Value::String(output_text_parts.join("")),
        );
    }
    if let Some(finish_reason) = finish_reason {
        response.insert("finish_reason".to_string(), Value::String(finish_reason));
    }
    if let Some(usage) = payload.get("usage") {
        response.insert("usage".to_string(), usage.clone());
    }
    Ok(Value::Object(response))
}

fn build_v3_responses_function_call_from_openai_chat_tool_call(
    call: &Value,
    custom_tool_names: &BTreeSet<String>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let object = call.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderSse(
            "OpenAI Chat tool_call must be an object before Responses projection".to_string(),
        )
    })?;
    let function = object
        .get("function")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderSse(
                "OpenAI Chat tool_call.function must be an object before Responses projection"
                    .to_string(),
            )
        })?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderSse(
                "OpenAI Chat tool_call.function.name is required before Responses projection"
                    .to_string(),
            )
        })?;
    let arguments = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let call_id = object
        .get("id")
        .or_else(|| object.get("call_id"))
        .or_else(|| object.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderSse(
                "OpenAI Chat tool_call id is required before Responses projection".to_string(),
            )
        })?;
    if custom_tool_names.contains(name) {
        let input =
            extract_v3_responses_custom_tool_input_from_openai_chat_arguments(name, arguments)?;
        return Ok(json!({
            "type":"custom_tool_call",
            "call_id":call_id,
            "name":name,
            "input":input
        }));
    }
    Ok(json!({
        "type":"function_call",
        "call_id":call_id,
        "name":name,
        "arguments":arguments
    }))
}

fn collect_v3_responses_custom_tool_names(payload: &Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    collect_v3_responses_custom_tool_names_from_tools(payload.get("tools"), &mut names);
    for item in payload
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_v3_responses_custom_tool_names_from_tools(item.get("tools"), &mut names);
        }
    }
    names
}

fn collect_v3_responses_custom_tool_names_from_tools(
    tools: Option<&Value>,
    names: &mut BTreeSet<String>,
) {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        if tool.get("type").and_then(Value::as_str) != Some("custom") {
            continue;
        }
        if let Some(name) = tool
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            names.insert(name.to_string());
        }
    }
}

fn extract_v3_responses_custom_tool_input_from_openai_chat_arguments(
    name: &str,
    arguments: &str,
) -> Result<String, V3ResponsesRelayRuntimeError> {
    let parsed: Value = serde_json::from_str(arguments).map_err(|error| {
        V3ResponsesRelayRuntimeError::ProviderSse(format!(
            "OpenAI Chat custom tool_call {name} arguments must be JSON object with string input before Responses projection: {error}"
        ))
    })?;
    let object = parsed.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderSse(format!(
            "OpenAI Chat custom tool_call {name} arguments must be JSON object before Responses projection"
        ))
    })?;
    object
        .get("input")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderSse(format!(
                "OpenAI Chat custom tool_call {name} arguments.input must be string before Responses projection"
            ))
        })
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
        finish_reason: None,
        stopless_activation: false,
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

fn read_v3_runtime_finish_reason(value: &Value) -> Option<String> {
    read_v3_runtime_string_path(value, &["finish_reason"])
        .or_else(|| read_v3_runtime_string_path(value, &["finishReason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["stop_reason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["stopReason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["response", "finish_reason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["response", "finishReason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["response", "stop_reason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["response", "stopReason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["choices", "0", "finish_reason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["candidates", "0", "finishReason"]))
}

fn infer_v3_runtime_finish_reason(
    action: V3HubContinuationCommit,
    response_status: Option<&str>,
) -> Option<String> {
    match action {
        V3HubContinuationCommit::LocalContext => Some("tool_calls".to_string()),
        V3HubContinuationCommit::None | V3HubContinuationCommit::RemoteBinding => {
            match response_status.map(str::trim) {
                Some(status) if status.eq_ignore_ascii_case("completed") => {
                    Some("stop".to_string())
                }
                _ => None,
            }
        }
    }
}

fn response_has_stopless_activation(value: &Value) -> bool {
    value
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("call_id")
                    .and_then(Value::as_str)
                    .is_some_and(|call_id| call_id == "call_stopless_reasoning")
                    && item
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name == "exec_command")
            })
        })
}

fn read_v3_runtime_string_path(value: &Value, path: &[&str]) -> Option<String> {
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

async fn build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut terminal_response: Option<Value> = None;
    let mut output_items: Vec<Value> = Vec::new();
    let mut output_text = String::new();
    while let Some(chunk) = provider.next().await {
        let chunk = chunk?;
        if let Some(response) = observe_v3_runtime_responses_sse_transport_chunk(
            &chunk,
            &mut decoder,
            observation,
            &mut output_items,
            &mut output_text,
        )? {
            terminal_response = Some(response);
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSse(error.to_string()))?;
    terminal_response.ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderSse(
            V3_RESPONSES_RELAY_SSE_EOF_WITHOUT_TERMINAL_MESSAGE.to_string(),
        )
    })
}

async fn build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
    provider_protocol: V3HubProviderWireProtocol,
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
                provider,
                observation,
            )
            .await
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
                provider,
                observation,
            )
            .await
        }
        other => Err(V3ResponsesRelayRuntimeError::ProviderSse(format!(
            "Responses relay cannot decode provider SSE protocol {other:?}"
        ))),
    }
}

#[derive(Default)]
struct V3OpenAiChatStreamChoice {
    role: Option<String>,
    content: String,
    reasoning_content: String,
    finish_reason: Option<Value>,
    tool_calls: BTreeMap<usize, V3OpenAiChatStreamToolCall>,
}

#[derive(Default)]
struct V3OpenAiChatStreamToolCall {
    id: Option<String>,
    kind: Option<String>,
    function_name: Option<String>,
    function_arguments: String,
}

async fn build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut response_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut created: Option<Value> = None;
    let mut usage: Option<Value> = None;
    let mut choices = BTreeMap::<usize, V3OpenAiChatStreamChoice>::new();
    let mut terminal_seen = false;
    let mut done_seen = false;

    while let Some(chunk) = provider.next().await {
        let chunk = chunk?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSse(error.to_string()))?;
        for frame in frames {
            let Some((_event_type, data)) = parse_v3_runtime_sse_frame_fields(&frame)? else {
                continue;
            };
            if data == "[DONE]" {
                if !terminal_seen {
                    return Err(V3ResponsesRelayRuntimeError::ProviderSse(
                        "OpenAI Chat provider SSE emitted [DONE] before terminal finish_reason"
                            .to_string(),
                    ));
                }
                done_seen = true;
                continue;
            }
            if done_seen {
                return Err(V3ResponsesRelayRuntimeError::ProviderSse(
                    "OpenAI Chat provider SSE emitted data after [DONE]".to_string(),
                ));
            }
            let event: Value = serde_json::from_str(&data).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderSse(format!(
                    "OpenAI Chat provider SSE event is malformed: {error}"
                ))
            })?;
            if terminal_seen && is_v3_openai_chat_empty_sse_tail_sentinel(&event) {
                continue;
            }
            validate_v3_openai_chat_provider_response_payload(
                &event,
                V3HubProviderWireProtocol::OpenAiChat,
                V3HubTransportIntent::Sse,
            )
            .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSse(error.to_string()))?;
            observation
                .record_event(&event)
                .map_err(V3ResponsesRelayRuntimeError::ProviderSse)?;
            collect_openai_chat_stream_event(
                event,
                &mut response_id,
                &mut model,
                &mut created,
                &mut usage,
                &mut choices,
                &mut terminal_seen,
                observation,
            )?;
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSse(error.to_string()))?;
    if !terminal_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderSse(
            "OpenAI Chat provider SSE ended without terminal finish_reason".to_string(),
        ));
    }
    build_openai_chat_completion_from_stream_state(response_id, model, created, usage, choices)
}

fn is_v3_openai_chat_empty_sse_tail_sentinel(event: &Value) -> bool {
    let Some(object) = event.as_object() else {
        return false;
    };
    object
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(str::is_empty)
        && object
            .get("object")
            .and_then(Value::as_str)
            .is_some_and(str::is_empty)
        && object
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| choices.is_empty())
}

fn collect_openai_chat_stream_event(
    event: Value,
    response_id: &mut Option<String>,
    model: &mut Option<String>,
    created: &mut Option<Value>,
    usage: &mut Option<Value>,
    choices: &mut BTreeMap<usize, V3OpenAiChatStreamChoice>,
    terminal_seen: &mut bool,
    observation: &V3RuntimeStreamObservation,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let event_object = event.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderSse(
            "OpenAI Chat provider SSE event must be an object".to_string(),
        )
    })?;
    if response_id.is_none() {
        *response_id = read_v3_trimmed_string(event_object.get("id"));
    }
    if model.is_none() {
        *model = read_v3_trimmed_string(event_object.get("model"));
    }
    if created.is_none() {
        *created = event_object.get("created").cloned();
    }
    if let Some(next_usage) = event_object.get("usage").filter(|value| !value.is_null()) {
        *usage = Some(next_usage.clone());
    }
    let Some(event_choices) = event_object.get("choices").and_then(Value::as_array) else {
        return Ok(());
    };
    for choice_value in event_choices {
        let choice_object = choice_value.as_object().ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderSse(
                "OpenAI Chat provider SSE choice must be an object".to_string(),
            )
        })?;
        let index = choice_object
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let choice = choices.entry(index).or_default();
        if let Some(finish_reason) = choice_object
            .get("finish_reason")
            .filter(|value| !value.is_null())
        {
            choice.finish_reason = Some(finish_reason.clone());
            *terminal_seen = true;
            if let Some(reason) = finish_reason.as_str() {
                observation
                    .record_finish_reason(reason)
                    .map_err(V3ResponsesRelayRuntimeError::ProviderSse)?;
            }
        }
        let Some(delta) = choice_object.get("delta").and_then(Value::as_object) else {
            continue;
        };
        choice.role = read_v3_trimmed_string(delta.get("role")).or(choice.role.take());
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            choice.content.push_str(content);
        }
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            choice.reasoning_content.push_str(reasoning);
        }
        if let Some(tool_call_deltas) = delta.get("tool_calls").and_then(Value::as_array) {
            collect_openai_chat_stream_tool_call_deltas(choice, tool_call_deltas)?;
        }
    }
    Ok(())
}

fn collect_openai_chat_stream_tool_call_deltas(
    choice: &mut V3OpenAiChatStreamChoice,
    tool_call_deltas: &[Value],
) -> Result<(), V3ResponsesRelayRuntimeError> {
    for tool_call_value in tool_call_deltas {
        let tool_call_object = tool_call_value.as_object().ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderSse(
                "OpenAI Chat provider SSE tool_call delta must be an object".to_string(),
            )
        })?;
        let index = tool_call_object
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let tool_call = choice.tool_calls.entry(index).or_default();
        tool_call.id = read_v3_trimmed_string(tool_call_object.get("id")).or(tool_call.id.take());
        tool_call.kind =
            read_v3_trimmed_string(tool_call_object.get("type")).or(tool_call.kind.take());
        if let Some(function) = tool_call_object.get("function").and_then(Value::as_object) {
            tool_call.function_name =
                read_v3_trimmed_string(function.get("name")).or(tool_call.function_name.take());
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                tool_call.function_arguments.push_str(arguments);
            }
        }
    }
    Ok(())
}

fn build_openai_chat_completion_from_stream_state(
    response_id: Option<String>,
    model: Option<String>,
    created: Option<Value>,
    usage: Option<Value>,
    choices: BTreeMap<usize, V3OpenAiChatStreamChoice>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if choices.is_empty() {
        return Err(V3ResponsesRelayRuntimeError::ProviderSse(
            "OpenAI Chat provider SSE response did not contain choices".to_string(),
        ));
    }
    let mut materialized_choices = Vec::new();
    for (index, choice) in choices {
        let mut message = Map::new();
        message.insert(
            "role".to_string(),
            Value::String(choice.role.unwrap_or_else(|| "assistant".to_string())),
        );
        message.insert("content".to_string(), Value::String(choice.content));
        if !choice.reasoning_content.is_empty() {
            message.insert(
                "reasoning_content".to_string(),
                Value::String(choice.reasoning_content),
            );
        }
        if !choice.tool_calls.is_empty() {
            let mut tool_calls = Vec::new();
            for (tool_index, tool_call) in choice.tool_calls {
                let id = tool_call.id.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderSse(format!(
                        "OpenAI Chat provider SSE tool_call[{tool_index}] missing id"
                    ))
                })?;
                let function_name = tool_call.function_name.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderSse(format!(
                        "OpenAI Chat provider SSE tool_call[{tool_index}] missing function.name"
                    ))
                })?;
                tool_calls.push(json!({
                    "id": id,
                    "type": tool_call.kind.unwrap_or_else(|| "function".to_string()),
                    "function": {
                        "name": function_name,
                        "arguments": tool_call.function_arguments,
                    }
                }));
            }
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
        materialized_choices.push(json!({
            "index": index,
            "message": Value::Object(message),
            "finish_reason": choice.finish_reason.unwrap_or(Value::Null),
        }));
    }
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        Value::String(response_id.unwrap_or_else(|| "chatcmpl_openai_chat_stream".to_string())),
    );
    response.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    response.insert("choices".to_string(), Value::Array(materialized_choices));
    if let Some(model) = model {
        response.insert("model".to_string(), Value::String(model));
    }
    if let Some(created) = created {
        response.insert("created".to_string(), created);
    }
    if let Some(usage) = usage {
        response.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(response))
}

fn read_v3_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn observe_v3_runtime_responses_sse_transport_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    observation: &V3RuntimeStreamObservation,
    output_items: &mut Vec<Value>,
    output_text: &mut String,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSse(error.to_string()))?;
    let mut terminal_response = None;
    for frame in frames {
        let Some((event_type, data)) = parse_v3_runtime_sse_frame_fields(&frame)? else {
            continue;
        };
        if data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(&data).map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderSse(format!(
                "V3 Responses Relay SSE event is malformed: {error}"
            ))
        })?;
        observation
            .record_event(&event)
            .map_err(V3ResponsesRelayRuntimeError::ProviderSse)?;
        collect_v3_runtime_responses_event_payload_evidence(
            event_type.as_deref(),
            &event,
            output_items,
            output_text,
        );
        let semantic_event_type = event_type
            .as_deref()
            .or_else(|| event.get("type").and_then(Value::as_str));
        match semantic_event_type {
            Some("response.completed" | "response.done" | "response.requires_action") => {
                let mut response = event
                    .get("response")
                    .cloned()
                    .unwrap_or_else(|| event.clone());
                attach_required_action_from_sse_event(&mut response, &event);
                apply_responses_stream_protocol_events_to_terminal_response(
                    &mut response,
                    output_items,
                    output_text,
                )?;
                terminal_response = Some(response);
            }
            Some("response.failed" | "response.incomplete" | "response.error") => {
                let message = event
                    .pointer("/response/error/message")
                    .or_else(|| event.pointer("/error/message"))
                    .or_else(|| event.pointer("/response/incomplete_details/reason"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(V3_RESPONSES_RELAY_SSE_FAILED_MESSAGE);
                return Err(V3ResponsesRelayRuntimeError::ProviderSse(
                    message.to_string(),
                ));
            }
            _ => {}
        }
    }
    Ok(terminal_response)
}

fn attach_required_action_from_sse_event(response: &mut Value, event: &Value) {
    let Some(required_action) = event.get("required_action").cloned() else {
        return;
    };
    let Some(object) = response.as_object_mut() else {
        return;
    };
    object
        .entry("required_action".to_string())
        .or_insert(required_action);
}

fn parse_v3_runtime_sse_frame_fields(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
) -> Result<Option<(Option<String>, String)>, V3ResponsesRelayRuntimeError> {
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
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some((event_type, data.to_string())))
}

fn collect_v3_runtime_responses_event_payload_evidence(
    event_type: Option<&str>,
    event: &Value,
    output_items: &mut Vec<Value>,
    output_text: &mut String,
) {
    let semantic_event_type = event_type.or_else(|| event.get("type").and_then(Value::as_str));
    match semantic_event_type {
        Some("response.output_item.added" | "response.output_item.done") => {
            if let Some(item) = event.get("item").cloned() {
                upsert_v3_runtime_sse_output_item(output_items, item);
            }
        }
        Some("response.output_text.delta") => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                output_text.push_str(delta);
            }
        }
        Some("response.output_text.done") => {
            if let Some(text) = event.get("text").and_then(Value::as_str) {
                output_text.clear();
                output_text.push_str(text);
            }
        }
        Some("response.function_call_arguments.delta") => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                append_v3_runtime_sse_function_arguments(output_items, event, delta);
            }
        }
        Some("response.function_call_arguments.done") => {
            if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                set_v3_runtime_sse_function_arguments(output_items, event, arguments);
            }
        }
        _ => {}
    }
}

fn upsert_v3_runtime_sse_output_item(output_items: &mut Vec<Value>, item: Value) {
    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(call_id) = call_id {
        if let Some(existing) = output_items.iter_mut().find(|existing| {
            existing
                .get("call_id")
                .or_else(|| existing.get("id"))
                .and_then(Value::as_str)
                == Some(call_id.as_str())
        }) {
            *existing = item;
            return;
        }
    }
    output_items.push(item);
}

fn append_v3_runtime_sse_function_arguments(
    output_items: &mut [Value],
    event: &Value,
    delta: &str,
) {
    let Some(item) = find_v3_runtime_sse_function_item_mut(output_items, event) else {
        return;
    };
    let current = item
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    item["arguments"] = Value::String(format!("{current}{delta}"));
}

fn set_v3_runtime_sse_function_arguments(
    output_items: &mut [Value],
    event: &Value,
    arguments: &str,
) {
    if let Some(item) = find_v3_runtime_sse_function_item_mut(output_items, event) {
        item["arguments"] = Value::String(arguments.to_string());
    }
}

fn find_v3_runtime_sse_function_item_mut<'items>(
    output_items: &'items mut [Value],
    event: &Value,
) -> Option<&'items mut Value> {
    if let Some(output_index) = event.get("output_index").and_then(Value::as_u64) {
        return output_items.get_mut(output_index as usize);
    }
    let call_id = event
        .get("call_id")
        .or_else(|| event.get("item_id"))
        .and_then(Value::as_str);
    if let Some(call_id) = call_id {
        return output_items.iter_mut().find(|item| {
            item.get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                == Some(call_id)
        });
    }
    output_items.iter_mut().rev().find(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call" | "tool_call")
        )
    })
}

fn apply_responses_stream_protocol_events_to_terminal_response(
    response: &mut Value,
    output_items: &[Value],
    output_text: &str,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let object = response.as_object_mut().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderSse(
            "V3 Responses Relay SSE terminal response must be an object".to_string(),
        )
    })?;
    object
        .entry("status".to_string())
        .or_insert_with(|| Value::String("completed".to_string()));
    let output_is_empty = object
        .get("output")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    if output_is_empty {
        if !output_items.is_empty() {
            object.insert("output".to_string(), Value::Array(output_items.to_vec()));
        } else if !output_text.trim().is_empty() {
            object.insert(
                "output".to_string(),
                json!([{"type":"output_text","text":output_text}]),
            );
        }
    }
    Ok(())
}

fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(
    response: Value,
) -> V3ResponsesRelayClientStream {
    use futures_util::stream;

    let _owner = V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER;
    let event_name = match response.get("status").and_then(Value::as_str) {
        Some("failed" | "incomplete") => "response.failed",
        Some("requires_action") => "response.requires_action",
        _ => "response.completed",
    };
    let mut frames = Vec::new();
    if matches!(
        event_name,
        "response.completed" | "response.requires_action"
    ) {
        if let Some(response_id) = response.get("id").and_then(Value::as_str) {
            frames.push(Ok(build_v3_runtime_sse_json_frame(
                "response.created",
                &json!({
                    "type": "response.created",
                    "response": {
                        "id": response_id,
                        "status": response
                            .get("status")
                            .cloned()
                            .unwrap_or_else(|| json!("in_progress")),
                    }
                }),
            )));
            if let Some(output) = response.get("output").and_then(Value::as_array) {
                for (index, item) in output.iter().enumerate() {
                    let projected_item =
                        project_v3_responses_client_event_output_item_done_item(item);
                    frames.push(Ok(build_v3_runtime_sse_json_frame(
                        "response.output_item.done",
                        &json!({
                            "type": "response.output_item.done",
                            "response_id": response_id,
                            "output_index": index,
                            "item": projected_item,
                        }),
                    )));
                }
            }
        }
    }
    let payload = json!({
        "type": event_name,
        "response": response,
    });
    frames.push(Ok(build_v3_runtime_sse_json_frame(event_name, &payload)));
    frames.push(Ok(b"data: [DONE]\n\n".to_vec()));
    Box::pin(stream::iter(frames))
}

fn project_v3_responses_client_event_output_item_done_item(item: &Value) -> Value {
    if item.get("type").and_then(Value::as_str) != Some("output_text") {
        return item.clone();
    }
    let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
    let mut projected = json!({
        "type": "message",
        "role": "assistant",
        "content": [{
            "type": "output_text",
            "text": text,
        }],
    });
    if let Some(id) = item.get("id").cloned() {
        projected["id"] = id;
    }
    projected
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
            ));
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
        provider_snapshots: None,
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

    fn test_provider_request(
        stream_intent: routecodex_v3_provider_responses::V3ResponsesStreamIntent,
    ) -> V3Transport13ResponsesHttpRequest {
        build_v3_transport_13_responses_http_request_from_parts(
            "req_snap_1",
            "provider_snap",
            "https://provider.example/v1/responses",
            V3ProviderAuthHandle {
                alias: "provider_snap:key1:test".to_string(),
                secret: V3ProviderAuthSecretHandle::Environment(
                    "ROUTECODEX_TEST_KEY".to_string(),
                ),
            },
            stream_intent,
            json!({
                "model": "gpt-test",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": "snap test",
                    "tools": [{
                        "type": "function",
                        "name": "exec",
                        "parameters": {"type":"object"}
                    }]
                }],
                "stream": stream_intent == routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse
            }),
        )
        .expect("test provider request")
    }

    #[derive(Clone)]
    struct JsonSnapTransport;

    #[async_trait::async_trait]
    impl ResponsesTransport for JsonSnapTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_snap_json","status":"completed","output_text":"ok"}"#.to_vec(),
            ))
        }
    }

    #[tokio::test]
    async fn runtime_provider_snap_captures_provider_request_and_json_response() {
        let transport = V3LiveSnapResponsesTransport {
            inner: JsonSnapTransport,
            snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
        };

        let raw = transport
            .send(test_provider_request(
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json,
            ))
            .await
            .expect("provider response");
        let bytes = raw.into_body_bytes().await.expect("json body survives");
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["output_text"],
            "ok"
        );

        let provider_request = transport
            .snapshots()
            .provider_request_payload()
            .expect("provider request snapshot");
        assert_eq!(provider_request["attempts"][0]["attempt"], 1);
        assert_eq!(
            provider_request["attempts"][0]["request"]["body"]["input"][0]["tools"][0]["name"],
            "exec"
        );
        assert_eq!(
            provider_request["attempts"][0]["request"]["headers"]["authorization"],
            "[REDACTED]"
        );
        assert!(
            provider_request["attempts"][0]["request"]["body"]
                .get("tools")
                .is_none(),
            "snap capture must not rebuild nested tool shape into top-level tools"
        );

        let provider_response = transport
            .snapshots()
            .provider_response_payload()
            .expect("provider response snapshot");
        assert_eq!(
            provider_response["attempts"][0]["response"]["body"]["output_text"],
            "ok"
        );
        assert_eq!(
            provider_response["attempts"][0]["response"]["bodyKind"],
            "json"
        );
    }

    #[tokio::test]
    async fn runtime_provider_snap_respects_stage_selector_for_provider_request_only() {
        let transport = V3LiveSnapResponsesTransport {
            inner: JsonSnapTransport,
            snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
        };

        let raw = transport
            .send(test_provider_request(
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json,
            ))
            .await
            .expect("provider response");
        let _ = raw.into_body_bytes().await.expect("json body survives");

        assert!(
            transport.snapshots().provider_request_payload().is_some(),
            "provider-request stage must be available when selected"
        );
        assert!(
            transport
                .snapshots()
                .provider_response_payload_for_selector("client-request,provider-request")
                .is_none(),
            "provider-response stage must stay off when selector excludes it"
        );
    }

    #[derive(Clone)]
    struct SseSnapTransport;

    #[async_trait::async_trait]
    impl ResponsesTransport for SseSnapTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(futures_util::stream::iter(vec![
                    Ok(b"event: response.output_text.delta\ndata: {\"delta\":\"he\"}\n\n"
                        .to_vec()),
                    Ok(b"event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n".to_vec()),
                ])),
            ))
        }
    }

    #[tokio::test]
    async fn runtime_provider_snap_captures_sse_response_without_consuming_stream() {
        let transport = V3LiveSnapResponsesTransport {
            inner: SseSnapTransport,
            snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
        };

        let raw = transport
            .send(test_provider_request(
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse,
            ))
            .await
            .expect("provider response");
        let bytes = raw.into_body_bytes().await.expect("sse body survives");
        let sse_text = String::from_utf8(bytes).unwrap();
        assert!(sse_text.contains("response.output_text.delta"));
        assert!(sse_text.contains("response.completed"));

        let provider_response = transport
            .snapshots()
            .provider_response_payload()
            .expect("provider response snapshot");
        assert_eq!(
            provider_response["attempts"][0]["response"]["bodyKind"],
            "sse"
        );
        let raw_sse = provider_response["attempts"][0]["response"]["rawSse"]
            .as_str()
            .expect("raw SSE");
        assert!(raw_sse.contains("response.output_text.delta"));
        assert!(raw_sse.contains("response.completed"));
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
    async fn provider_sse_eof_without_terminal_fails_before_client_projection() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
        )]));
        let error = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("provider SSE stream ended before response.completed"));
    }

    #[tokio::test]
    async fn provider_sse_failed_terminal_returns_provider_sse_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream stream failed\"}}}\n\n".to_vec(),
        )]));
        let error = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("upstream stream failed"));
        assert_eq!(
            observation.snapshot().unwrap().response_status.as_deref(),
            Some("failed")
        );
    }

    #[tokio::test]
    async fn provider_sse_done_terminal_aggregates_and_projects_completed_frames() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()),
            Ok(b"event: response.done\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap();

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["type"], "output_text");
        assert_eq!(response["output"][0]["text"], "partial");
        let snapshot = observation.snapshot().unwrap();
        assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
        assert_eq!(
            snapshot.usage.as_ref().and_then(|usage| usage.total_tokens),
            Some(3)
        );

        let projected = collect_projected_sse(
            build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(response),
        )
        .await;
        assert!(projected[0].as_ref().unwrap().contains("response.created"));
        assert!(projected[1]
            .as_ref()
            .unwrap()
            .contains("response.output_item.done"));
        assert!(projected[2]
            .as_ref()
            .unwrap()
            .contains("response.completed"));
        assert_eq!(projected[3].as_ref().unwrap(), "data: [DONE]\n\n");
    }

    #[tokio::test]
    async fn provider_sse_requires_action_terminal_preserves_required_action() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.requires_action\ndata: {\"type\":\"response.requires_action\",\"response\":{\"id\":\"resp_required\",\"status\":\"requires_action\"},\"required_action\":{\"type\":\"submit_tool_outputs\"}}\n\n".to_vec(),
        )]));
        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap();

        assert_eq!(response["status"], "requires_action");
        assert_eq!(
            response["required_action"]["type"].as_str(),
            Some("submit_tool_outputs")
        );
    }
}
