use super::*;
use crate::provider_failure_runtime_policy::{
    resolve_v3_relay_target, run_v3_relay_provider_failure_policy,
    v3_relay_provider_candidate_key_parts, v3_relay_provider_policy_now_epoch_ms,
    v3_relay_provider_target_selection_sample, V3ProviderFailureRuntimeHealth,
    V3RelayProviderFailureDecision, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyEvent, V3RelayProviderFailurePolicyState,
    V3RelayProviderFailureRetryPolicy, V3RelayProviderTargetResolutionInput,
    V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS, V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET,
};
use futures_util::StreamExt;
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ProviderErrorActionPolicyManifest,
    V3ProviderErrorMatcherManifest,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_http_request_from_parts,
    build_v3_transport_13_responses_http_request_from_v3_provider_12, ReqwestResponsesTransport,
    ResponsesTransport, V3Provider12ResponsesWirePayload, V3ProviderAuthHandle,
    V3ProviderAuthSecretHandle, V3ProviderError, V3ProviderHealthStore, V3ProviderResp14Raw,
    V3ProviderResponseBody, V3ProviderResponseHeader, V3ResponsesProviderTarget,
    V3ResponsesStreamIntent, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

const V3_RESPONSES_RELAY_LOCAL_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;
const V3_RESPONSES_RELAY_PROVIDER_EVENT_EOF_WITHOUT_TERMINAL_MESSAGE: &str =
    "provider response event stream ended before response.completed";
const V3_RESPONSES_RELAY_PROVIDER_EVENT_FAILED_MESSAGE: &str =
    "provider response event stream failed before response.completed";
const V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER: &str = "ProviderRespInbound01Raw -> V3HubRespInbound02Normalized (Responses event codec; SSE transport is opaque framing)";
const V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER: &str =
    "V3HubRespOutbound05ClientSemantic -> V3ServerRespOutbound06ClientFrame";
const V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_COUNT: usize =
    V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET;
const V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_DELAY_MS: u64 =
    V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS;

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

pub struct V3ResponsesRelayLocalStoplessControlInput<'a> {
    pub state: &'a V3ResponsesRelayLocalContinuationState,
    pub stopless_control: &'a V3ResponsesRelayStoplessControlState,
    pub scope: V3ResponsesRelayLocalContinuationScope,
    pub now_epoch_ms: u64,
}

impl<'a> V3ResponsesRelayLocalStoplessControlInput<'a> {
    pub fn new(
        state: &'a V3ResponsesRelayLocalContinuationState,
        stopless_control: &'a V3ResponsesRelayStoplessControlState,
        scope: V3ResponsesRelayLocalContinuationScope,
        now_epoch_ms: u64,
    ) -> Self {
        Self {
            state,
            stopless_control,
            scope,
            now_epoch_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3ResponsesRelayProviderSnapshotCapture {
    pub provider_request: bool,
    pub provider_response: bool,
}

impl V3ResponsesRelayProviderSnapshotCapture {
    pub fn new(provider_request: bool, provider_response: bool) -> Self {
        Self {
            provider_request,
            provider_response,
        }
    }
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

impl V3ResponsesRelayRetryPolicy {
    pub fn default_floor_delay_ms_for_retry(&self, _retry_number: usize) -> u64 {
        self.retry_delay_ms
    }

    fn as_shared_policy(self) -> V3RelayProviderFailureRetryPolicy {
        V3RelayProviderFailureRetryPolicy {
            same_candidate_retries: self.same_candidate_retries,
            retry_delay_ms: self.retry_delay_ms,
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
pub struct V3RuntimeProviderFailureObservation {
    pub provider_key: String,
    pub provider_id: String,
    pub auth_alias: Option<String>,
    pub model_id: String,
    pub status: u16,
    pub error_type: Option<String>,
    pub message: String,
    pub failure_count: u32,
    pub health_state: String,
    pub cooldown_until_ms: Option<u64>,
    pub action: String,
    pub next_provider_key: Option<String>,
    pub wait_ms: Option<u64>,
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
    pub provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
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
    provider_failure_events: &'state mut Vec<V3RuntimeProviderFailureObservation>,
    trace: &'state mut Vec<&'static str>,
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
pub struct V3ResponsesRelayStoplessControlScope {
    entry_endpoint: String,
    session_id: String,
    conversation_id: String,
    port: u16,
    routing_group: String,
}

impl V3ResponsesRelayStoplessControlScope {
    pub fn new(
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

    fn has_client_session_scope(&self) -> bool {
        let session_id = self.session_id.trim();
        let conversation_id = self.conversation_id.trim();
        if session_id.is_empty() || conversation_id.is_empty() {
            return false;
        }
        !(session_id == conversation_id && session_id.starts_with("request:"))
    }
}

impl From<&V3ResponsesRelayLocalContinuationScope> for V3ResponsesRelayStoplessControlScope {
    fn from(scope: &V3ResponsesRelayLocalContinuationScope) -> Self {
        Self::new(
            scope.entry_endpoint.clone(),
            scope.session_id.clone(),
            scope.conversation_id.clone(),
            scope.port,
            scope.routing_group.clone(),
        )
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

impl From<&V3ResponsesRelayStoplessControlScope> for V3ResponsesRelayStoplessControlKey {
    fn from(scope: &V3ResponsesRelayStoplessControlScope) -> Self {
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
        scope: &V3ResponsesRelayStoplessControlScope,
    ) -> Result<Option<V3StoplessCenterState>, V3ResponsesRelayRuntimeError> {
        Ok(self
            .lock_store()?
            .get(&V3ResponsesRelayStoplessControlKey::from(scope))
            .cloned())
    }

    pub fn store_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
        state: V3StoplessCenterState,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.lock_store()?
            .insert(V3ResponsesRelayStoplessControlKey::from(scope), state);
        Ok(())
    }

    pub fn clear_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
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
            | V3ProviderError::InvalidStreamIntent { request_id }
            | V3ProviderError::ControlFieldInWireBody { request_id, .. } => {
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
    #[error("V3 Responses Relay inbound canonicalization failed: {0}")]
    InboundCanonical(String),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 Responses Relay target resolution failed: {0}")]
    Target(String),
    #[error("V3 Responses Relay provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 Responses Relay provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 Responses Relay provider wire encoding failed: {0}")]
    ProviderWireEncoding(String),
    #[error("V3 Responses Relay provider health failed: {0}")]
    ProviderHealth(String),
    #[error("V3 Responses Relay JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 Responses Relay provider SSE transport failed: {0}")]
    ProviderSseTransport(String),
    #[error("V3 Responses Relay provider response event codec failed: {0}")]
    ProviderResponseEventCodec(String),
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
        }),
        None,
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
        }),
        None,
        provider_health.store.clone(),
        V3ResponsesRelayRetryPolicy::default(),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control<
    T: ResponsesTransport,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayStoplessControlScope,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        None,
        Some(V3ResponsesRelayStoplessControlExecution {
            control: stopless_control,
            scope,
            commit_effects: true,
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
    local_stopless: V3ResponsesRelayLocalStoplessControlInput<'_>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&local_stopless.scope);
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state: local_stopless.state,
            scope: local_stopless.scope,
            now_epoch_ms: local_stopless.now_epoch_ms,
            commit_resp04_effects: true,
        }),
        Some(V3ResponsesRelayStoplessControlExecution {
            control: local_stopless.stopless_control,
            scope: stopless_scope,
            commit_effects: true,
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
        V3ResponsesRelayLocalStoplessControlInput::new(
            state,
            stopless_control,
            scope,
            now_epoch_ms,
        ),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_provider_snapshots(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    local_stopless: V3ResponsesRelayLocalStoplessControlInput<'_>,
    capture: V3ResponsesRelayProviderSnapshotCapture,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let transport = V3LiveSnapResponsesTransport::with_default_transport();
    let snapshots = transport.snapshots();
    let mut output =
        execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
            manifest,
            input,
            &transport,
            provider_health,
            local_stopless,
        )
        .await?;
    output.provider_snapshots =
        Some(snapshots.into_payload(capture.provider_request, capture.provider_response));
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
        }),
        None,
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
}

struct V3ResponsesRelayStoplessControlExecution<'state> {
    control: &'state V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayStoplessControlScope,
    commit_effects: bool,
}

async fn execute_v3_responses_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    stopless_control: Option<V3ResponsesRelayStoplessControlExecution<'_>>,
    provider_health: V3ProviderHealthStore,
    retry_policy: V3ResponsesRelayRetryPolicy,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3ResponsesRelayRuntimeError::StaticRegistry(error.to_string()))?;
    let transition_request_id = input.request_id.clone();
    let transition_updated_at = local
        .as_ref()
        .map(|execution| execution.now_epoch_ms)
        .unwrap_or(v3_responses_relay_now_epoch_ms()?);
    let stopless_control_has_client_session_scope = stopless_control
        .as_ref()
        .map(|execution| execution.scope.has_client_session_scope())
        .unwrap_or(true);
    let mut trace = Vec::with_capacity(17);
    let client_response_transport_intent =
        v3_responses_relay_transport_intent_from_stream_field(&input.payload);
    let provider_request_transport_intent = client_response_transport_intent;
    let local_tool_output_ids = find_responses_tool_output_ids(&input.payload)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        client_response_transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let req02 =
        build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(req01)
            .map_err(V3ResponsesRelayRuntimeError::InboundCanonical)?;
    trace.push("V3HubReqInbound02Normalized");
    let base_hub_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        &input.server_id,
        server_routing_group(manifest, &input.server_id)?,
        &input.request_id,
    );
    let request_stopless_control_state =
        load_v3_responses_relay_stopless_control_state(manifest, stopless_control.as_ref())?;
    let request_hook_profile = responses_relay_request_hook_profile(
        manifest,
        request_stopless_control_state.as_ref(),
        stopless_control_has_client_session_scope,
        &transition_request_id,
        transition_updated_at,
    );
    let request_outcome = {
        let local_store_guard = if let (Some(local), Some(_)) =
            (local.as_ref(), local_tool_output_ids.restore_ids.first())
        {
            Some(local.state.lock_store()?)
        } else {
            None
        };
        let lookup = if let (Some(local), Some(context_id)) =
            (local.as_ref(), local_tool_output_ids.restore_ids.first())
        {
            if local.scope.routing_group != server_routing_group(manifest, &input.server_id)? {
                return Err(V3ResponsesRelayRuntimeError::LocalContinuationScopeMismatch);
            }
            let store = local_store_guard
                .as_deref()
                .ok_or(V3ResponsesRelayRuntimeError::LocalContinuationStatePoisoned)?;
            V3HubContinuationLookup::new(Some(context_id), local.scope.hub_scope(&input.server_id))
                .with_local_context_from_req04_store(
                    context_id,
                    local.scope.hub_scope(&input.server_id),
                    store,
                    local.scope.local_key(),
                    local.now_epoch_ms,
                    &local_tool_output_ids.restore_ids[1..],
                )?
        } else {
            V3HubContinuationLookup::new(None, base_hub_scope)
        };
        compile_v3_hub_relay_request_hooks().run_from_normalized(
            req02,
            &lookup,
            &request_hook_profile,
        )?
    };
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let stopless_state = request_outcome.stopless_state().cloned();
    apply_v3_responses_relay_stopless_control_request_transition(
        manifest,
        stopless_control.as_ref(),
        request_stopless_control_state.is_some(),
        stopless_state.as_ref(),
    )?;
    macro_rules! try_before_resp03 {
        ($expr:expr) => {
            match $expr {
                Ok(value) => value,
                Err(error) => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(error.into());
                }
            }
        };
    }
    let provider_semantic_body = request_outcome.payload().clone();
    let route_facts_body = request_outcome
        .responses_original_input_surface_payload()
        .unwrap_or_else(|| provider_semantic_body.clone());
    let local_continuation_request_body = route_facts_body.clone();
    let req04 = request_outcome.into_governed();
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let provider_health = V3ProviderFailureRuntimeHealth::from(provider_health);
    let mut failed_candidates = BTreeSet::new();
    let mut pending_provider_failure: Option<V3ResponsesRelayProviderFailure> = None;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut provider_send_attempts = 0usize;
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let shared_retry_policy = retry_policy.as_shared_policy();
    let provider_failure_health = provider_health.clone();
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        server_id: &input.server_id,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        route_facts_body: &route_facts_body,
        provider_health: &provider_failure_health,
        retry_policy: shared_retry_policy,
        deterministic_sample,
    };
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else {
            match resolve_v3_relay_target(V3RelayProviderTargetResolutionInput {
                manifest,
                server_id: &input.server_id,
                entry_kind: "responses",
                endpoint_path: "/v1/responses",
                body: &route_facts_body,
                request_local_excluded_candidates: &failed_candidates,
                provider_health: &provider_health,
                now_ms: v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                deterministic_sample,
            }) {
                Ok(selected) => selected,
                Err(error) => {
                    if let Some(failure) = pending_provider_failure.take() {
                        clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                            manifest,
                            stopless_control.as_ref(),
                            stopless_state.as_ref(),
                        )?;
                        return Ok(provider_failure_output(failure, trace, 0));
                    }
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::Target(error));
                }
            }
        };
        provider_send_attempts = provider_send_attempts.saturating_add(1);
        let mut selected_observability =
            build_v3_relay_observability_from_selected(&selected, client_response_transport_intent);
        selected_observability.attempts = Some(provider_send_attempts);
        selected_observability.provider_failure_events = provider_failure_events.clone();
        let selected_target_provider_id = selected.candidate.provider_id.clone();
        let selected_target_auth_alias = selected.candidate.auth_alias.clone();
        let selected_target_model_id = selected.candidate.model_id.clone();
        let provider_wire_protocol = try_before_resp03!(
            provider_wire_protocol_for_selected_candidate(&selected.candidate)
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = try_before_resp03!(provider_target(manifest, req07.selected_target()));
        let req_compat = try_before_resp03!(
            build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        );
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = _req09.into_provider_semantic_payload();
        let wire = try_before_resp03!(build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        ));
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request = try_before_resp03!(
            build_v3_provider_transport_request_for_protocol(provider_wire_protocol, wire)
        );
        try_before_resp03!(
            validate_v3_responses_relay_provider_request_transport_intent(
                provider_request_transport_intent,
                transport_request.stream_intent(),
            )
        );
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
                let terminal_failure = try_before_resp03!(
                    handle_v3_responses_relay_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3ResponsesRelayProviderRetryState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            retry_selected: &mut retry_selected,
                            pending_provider_failure: &mut pending_provider_failure,
                            provider_failure_events: &mut provider_failure_events,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
            Err(error) => {
                let failure = provider_runtime_failure(
                    error,
                    &selected_target_provider_id,
                    Some(selected_observability),
                );
                let terminal_failure = try_before_resp03!(
                    handle_v3_responses_relay_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3ResponsesRelayProviderRetryState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            retry_selected: &mut retry_selected,
                            pending_provider_failure: &mut pending_provider_failure,
                            provider_failure_events: &mut provider_failure_events,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
        };
        let provider_status = provider_raw.status();
        let provider_id = provider_raw.provider_id().to_string();
        match provider_raw.into_body() {
            V3ProviderResponseBody::Json(bytes) => {
                let provider_value: Value = match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(error) => {
                        let failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: input.request_id.clone(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!("provider JSON response decode failed: {error}"),
                            },
                            &selected_target_provider_id,
                            Some(selected_observability),
                        );
                        let terminal_failure = try_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_provider_failure: &mut pending_provider_failure,
                                    provider_failure_events: &mut provider_failure_events,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                };
                let hook_provider_value =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        try_before_resp03!(project_v3_anthropic_message_as_responses_response(
                            &provider_value
                        )
                        .map_err(|error| {
                            V3ResponsesRelayRuntimeError::InboundCanonical(error.to_string())
                        }))
                    } else {
                        provider_value.clone()
                    };
                let hook_provider_protocol =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        V3HubProviderWireProtocol::Responses
                    } else {
                        provider_wire_protocol
                    };
                if provider_wire_protocol == V3HubProviderWireProtocol::OpenAiChat {
                    if let Some(semantic_error) = provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    ) {
                        let failure = provider_semantic_failure(
                            provider_status,
                            semantic_error,
                            &selected_target_provider_id,
                            Some(selected_observability),
                        );
                        let terminal_failure = try_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_provider_failure: &mut pending_provider_failure,
                                    provider_failure_events: &mut provider_failure_events,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let (action, finalized_provider_value, response_stopless_state) =
                    match run_json_response_hooks(
                        V3ResponsesRelayJsonResponseHookInput {
                            provider_value: &hook_provider_value,
                            provider_semantic_body: &provider_semantic_body,
                            manifest,
                            provider_id: Some(&selected_target_provider_id),
                            provider_protocol: hook_provider_protocol,
                            provider_response_transport_intent: V3HubTransportIntent::Json,
                            compatibility_profile: selected
                                .candidate
                                .compatibility_profile
                                .as_deref(),
                            stopless_state: stopless_state.as_ref(),
                            stopless_control_has_client_session_scope,
                            transition_request_id: &transition_request_id,
                            transition_updated_at,
                        },
                        &mut trace,
                    ) {
                        Ok(value) => value,
                        Err(error) if is_v3_responses_provider_response_failure(&error) => {
                            let failure = provider_runtime_failure(
                                provider_response_hook_failure(
                                    error,
                                    &input.request_id,
                                    &selected_target_provider_id,
                                ),
                                &selected_target_provider_id,
                                Some(selected_observability),
                            );
                            let terminal_failure = try_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure,
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_provider_failure: &mut pending_provider_failure,
                                        provider_failure_events: &mut provider_failure_events,
                                        trace: &mut trace,
                                    },
                                )
                                .await
                            );
                            if let Some(failure) = terminal_failure {
                                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                    manifest,
                                    stopless_control.as_ref(),
                                    stopless_state.as_ref(),
                                )?;
                                return Ok(provider_failure_output(failure, trace, 0));
                            }
                            continue;
                        }
                        Err(error) => try_before_resp03!(Err(error)),
                    };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    stopless_control.as_ref(),
                    response_stopless_state,
                )?;
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    &local_continuation_request_body,
                    &finalized_provider_value,
                    action,
                )?;
                try_before_resp03!(provider_health
                    .record_provider_success(
                        &selected_target_provider_id,
                        Some(&selected_target_auth_alias),
                        Some(&selected_target_model_id),
                        v3_responses_relay_now_epoch_ms()?,
                    )
                    .map_err(|error| V3ResponsesRelayRuntimeError::ProviderHealth(
                        error.to_string()
                    )));
                let mut observability = selected_observability;
                observability.provider_status = Some(provider_status);
                observability.provider_id = Some(provider_id);
                observability.transport =
                    v3_transport_intent_label(client_response_transport_intent).to_string();
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
                let client_body = project_v3_responses_relay_client_body(
                    client_response_transport_intent,
                    finalized_provider_value,
                );
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body,
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
                    match build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
                        provider_wire_protocol,
                        stream,
                        &stream_observation,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(error) => {
                            let failure = provider_runtime_failure(
                                provider_response_stream_failure(
                                    error,
                                    &input.request_id,
                                    &selected_target_provider_id,
                                ),
                                &selected_target_provider_id,
                                Some(selected_observability),
                            );
                            let terminal_failure = try_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure,
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_provider_failure: &mut pending_provider_failure,
                                        provider_failure_events: &mut provider_failure_events,
                                        trace: &mut trace,
                                    },
                                )
                                .await
                            );
                            if let Some(failure) = terminal_failure {
                                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                    manifest,
                                    stopless_control.as_ref(),
                                    stopless_state.as_ref(),
                                )?;
                                return Ok(provider_failure_output(failure, trace, 0));
                            }
                            continue;
                        }
                    };
                let hook_provider_protocol =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        V3HubProviderWireProtocol::Responses
                    } else {
                        provider_wire_protocol
                    };
                if provider_wire_protocol == V3HubProviderWireProtocol::OpenAiChat {
                    if let Some(semantic_error) = provider_response_semantic_error_from_manifest(
                        Some(manifest),
                        Some(&selected_target_provider_id),
                        &provider_value,
                    ) {
                        let failure = provider_semantic_failure(
                            provider_status,
                            semantic_error,
                            &selected_target_provider_id,
                            Some(selected_observability),
                        );
                        let terminal_failure = try_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_provider_failure: &mut pending_provider_failure,
                                    provider_failure_events: &mut provider_failure_events,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let (action, finalized_provider_value, response_stopless_state) =
                    match run_json_response_hooks(
                        V3ResponsesRelayJsonResponseHookInput {
                            provider_value: &provider_value,
                            provider_semantic_body: &provider_semantic_body,
                            manifest,
                            provider_id: Some(&selected_target_provider_id),
                            provider_protocol: hook_provider_protocol,
                            provider_response_transport_intent: V3HubTransportIntent::Sse,
                            compatibility_profile: selected
                                .candidate
                                .compatibility_profile
                                .as_deref(),
                            stopless_state: stopless_state.as_ref(),
                            stopless_control_has_client_session_scope,
                            transition_request_id: &transition_request_id,
                            transition_updated_at,
                        },
                        &mut trace,
                    ) {
                        Ok(value) => value,
                        Err(error) if is_v3_responses_provider_response_failure(&error) => {
                            let failure = provider_runtime_failure(
                                provider_response_hook_failure(
                                    error,
                                    &input.request_id,
                                    &selected_target_provider_id,
                                ),
                                &selected_target_provider_id,
                                Some(selected_observability),
                            );
                            let terminal_failure = try_before_resp03!(
                                handle_v3_responses_relay_provider_failure(
                                    &failure_context,
                                    selected,
                                    failure,
                                    &mut V3ResponsesRelayProviderRetryState {
                                        failed_candidates: &mut failed_candidates,
                                        same_candidate_retries: &mut same_candidate_retries,
                                        retry_selected: &mut retry_selected,
                                        pending_provider_failure: &mut pending_provider_failure,
                                        provider_failure_events: &mut provider_failure_events,
                                        trace: &mut trace,
                                    },
                                )
                                .await
                            );
                            if let Some(failure) = terminal_failure {
                                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                    manifest,
                                    stopless_control.as_ref(),
                                    stopless_state.as_ref(),
                                )?;
                                return Ok(provider_failure_output(failure, trace, 0));
                            }
                            continue;
                        }
                        Err(error) => try_before_resp03!(Err(error)),
                    };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    stopless_control.as_ref(),
                    response_stopless_state,
                )?;
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    &local_continuation_request_body,
                    &finalized_provider_value,
                    action,
                )?;
                try_before_resp03!(provider_health
                    .record_provider_success(
                        &selected_target_provider_id,
                        Some(&selected_target_auth_alias),
                        Some(&selected_target_model_id),
                        v3_responses_relay_now_epoch_ms()?,
                    )
                    .map_err(|error| V3ResponsesRelayRuntimeError::ProviderHealth(
                        error.to_string()
                    )));
                stream_observation
                    .record_event(&json!({
                        "type":"response.completed",
                        "response": finalized_provider_value.clone()
                    }))
                    .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
                let mut observability = selected_observability;
                observability.provider_status = Some(provider_status);
                observability.provider_id = Some(provider_id);
                observability.transport =
                    v3_transport_intent_label(client_response_transport_intent).to_string();
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
                        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
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
                let client_response_is_sse =
                    client_response_transport_intent == V3HubTransportIntent::Sse;
                let client_body = project_v3_responses_relay_client_body(
                    client_response_transport_intent,
                    finalized_provider_value,
                );
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 200,
                    client_body,
                    node_trace: trace,
                    error_chain: None,
                    observability: Some(observability),
                    stream_observation: if client_response_is_sse {
                        Some(stream_observation)
                    } else {
                        None
                    },
                    provider_snapshots: None,
                });
            }
        }
    }
}

fn provider_wire_protocol_for_selected_candidate(
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3HubProviderWireProtocol, V3ResponsesRelayRuntimeError> {
    provider_wire_protocol_for_provider_type(&selected.provider_id, &selected.provider_type)
        .map_err(|error| V3ResponsesRelayRuntimeError::Target(format!("Responses relay {error}")))
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
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_anthropic_messages_transport_request_from_v3_provider_08(wire)
                .map_err(V3ResponsesRelayRuntimeError::ProviderWireEncoding)
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
    let previous_response_id = payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
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
        if is_v3_stopless_internal_call_id(id) {
            if let Some(response_id) = previous_response_id {
                if !ids
                    .consumed_ids
                    .iter()
                    .any(|existing| existing == response_id)
                {
                    ids.consumed_ids.push(response_id.to_owned());
                }
                if !ids
                    .restore_ids
                    .iter()
                    .any(|existing| existing == response_id)
                {
                    ids.restore_ids.push(response_id.to_owned());
                }
                continue;
            }
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
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    mut failure: V3ResponsesRelayProviderFailure,
    state: &mut V3ResponsesRelayProviderRetryState<'_>,
) -> Result<Option<V3ResponsesRelayProviderFailure>, V3ResponsesRelayRuntimeError> {
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.status,
        failure
            .client_response
            .pointer("/error/type")
            .and_then(Value::as_str)
            .map(str::to_string),
        v3_responses_relay_provider_failure_reason(&failure)
            .unwrap_or("provider failure")
            .to_string(),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: state.failed_candidates,
            same_candidate_retries: state.same_candidate_retries,
            trace: state.trace,
        },
    )
    .await
    .map_err(V3ResponsesRelayRuntimeError::ProviderHealth)?;
    state
        .provider_failure_events
        .push(build_v3_runtime_provider_failure_observation_from_policy_event(&result.event));
    failure = attach_v3_provider_failure_events_to_failure(failure, state.provider_failure_events);
    match result.decision {
        V3RelayProviderFailureDecision::Reselect => {
            *state.pending_provider_failure = Some(failure);
            Ok(None)
        }
        V3RelayProviderFailureDecision::RetrySame(selected) => {
            *state.retry_selected = Some(*selected);
            Ok(None)
        }
        V3RelayProviderFailureDecision::ProjectTerminal => Ok(Some(failure)),
    }
}

fn v3_responses_relay_provider_failure_reason(
    failure: &V3ResponsesRelayProviderFailure,
) -> Option<&str> {
    failure
        .client_response
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| {
            failure
                .client_response
                .pointer("/error/type")
                .and_then(Value::as_str)
        })
}

fn build_v3_runtime_provider_failure_observation_from_policy_event(
    event: &V3RelayProviderFailurePolicyEvent,
) -> V3RuntimeProviderFailureObservation {
    V3RuntimeProviderFailureObservation {
        provider_key: v3_relay_provider_candidate_key_parts(
            &event.candidate.provider_id,
            Some(&event.candidate.auth_alias),
            Some(&event.candidate.model_id),
        ),
        provider_id: event.candidate.provider_id.clone(),
        auth_alias: Some(event.candidate.auth_alias.clone()),
        model_id: event.candidate.model_id.clone(),
        status: event.status,
        error_type: event.error_type.clone(),
        message: event.message.clone(),
        failure_count: event.health_record.failure_count,
        health_state: event.health_record.state.clone(),
        cooldown_until_ms: event.health_record.cooldown_until_ms,
        action: event.action.clone(),
        next_provider_key: event.next_provider_key.clone(),
        wait_ms: event.wait_ms,
    }
}

fn attach_v3_provider_failure_events_to_failure(
    mut failure: V3ResponsesRelayProviderFailure,
    provider_failure_events: &[V3RuntimeProviderFailureObservation],
) -> V3ResponsesRelayProviderFailure {
    if let Some(observability) = failure.observability.as_mut() {
        observability.provider_failure_events = provider_failure_events.to_vec();
    }
    failure
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

pub async fn execute_v3_responses_relay_dry_run_runtime(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(manifest, input, None, None).await
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
        }),
        None,
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
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&scope);
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: false,
        }),
        Some(V3ResponsesRelayStoplessControlExecution {
            control: stopless_control,
            scope: stopless_scope,
            commit_effects: false,
        }),
    )
    .await
}

async fn execute_v3_responses_relay_dry_run_runtime_inner(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    stopless_control: Option<V3ResponsesRelayStoplessControlExecution<'_>>,
) -> crate::V3FoundationRuntimeOutput {
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3ProviderRequestDryRunNoNetworkTransport::new(
        json!({
            "id": format!("dry_run_{}", input.request_id),
            "object": "response",
            "status": "completed",
            "output_text": "routecodex provider-request dry-run stopped before provider send",
            "output": [{
                "type": "output_text",
                "text": "routecodex provider-request dry-run stopped before provider send"
            }]
        }),
        Arc::clone(&captured_provider_request),
    );
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(manifest);
    let mut output = match execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        &transport,
        local,
        stopless_control,
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
            let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
                source: source.clone(),
                action_scope: V3ErrorActionScope::None,
                candidates_remaining: 0,
                source_status: None,
            });
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

struct V3ResponsesRelayJsonResponseHookInput<'a> {
    provider_value: &'a Value,
    provider_semantic_body: &'a Value,
    manifest: &'a V3Config05ManifestPublished,
    provider_id: Option<&'a str>,
    provider_protocol: V3HubProviderWireProtocol,
    provider_response_transport_intent: V3HubTransportIntent,
    compatibility_profile: Option<&'a str>,
    stopless_state: Option<&'a V3StoplessCenterState>,
    stopless_control_has_client_session_scope: bool,
    transition_request_id: &'a str,
    transition_updated_at: u64,
}

fn run_json_response_hooks(
    input: V3ResponsesRelayJsonResponseHookInput<'_>,
    trace: &mut Vec<&'static str>,
) -> Result<
    (
        V3HubContinuationCommit,
        Value,
        Option<V3StoplessCenterState>,
    ),
    V3ResponsesRelayRuntimeError,
> {
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        input.provider_value.clone(),
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            input.provider_protocol,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            input.provider_response_transport_intent,
        )
        .with_compatibility_profile(input.compatibility_profile),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let mut resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    if input.provider_protocol == V3HubProviderWireProtocol::OpenAiChat {
        let converted =
            build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
                resp02.provider_payload(),
                input.provider_semantic_body,
                Some(input.manifest),
                input.provider_id,
            )?;
        *resp02.provider_payload_mut() = Arc::new(converted);
        resp02.provider_raw_mut().provider_protocol = V3HubProviderWireProtocol::Responses;
    }
    trace.push("V3HubRespInbound02Normalized");
    let response_hook_profile = responses_relay_response_hook_profile(
        input.manifest,
        input.stopless_state,
        input.stopless_control_has_client_session_scope,
        input.transition_request_id,
        input.transition_updated_at,
    );
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
    stopless_control_has_client_session_scope: bool,
    transition_request_id: &str,
    transition_updated_at: u64,
) -> V3HubServertoolRequestProfile {
    if !v3_stopless_center_enabled(manifest) || !stopless_control_has_client_session_scope {
        return V3HubServertoolRequestProfile::disabled();
    }
    let profile = V3HubServertoolRequestProfile::stopless_reasoning_stop()
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
    match stopless_state {
        Some(state) => profile.with_stopless_center_state(state.clone()),
        None => profile,
    }
}

fn responses_relay_response_hook_profile(
    manifest: &V3Config05ManifestPublished,
    stopless_state: Option<&V3StoplessCenterState>,
    stopless_control_has_client_session_scope: bool,
    transition_request_id: &str,
    transition_updated_at: u64,
) -> V3HubRelayResponseHookProfile {
    if !v3_stopless_center_enabled(manifest) || !stopless_control_has_client_session_scope {
        return V3HubRelayResponseHookProfile::empty();
    }
    let profile = V3HubRelayResponseHookProfile::empty()
        .with_stopless_reasoning_stop()
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
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
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
) -> Result<Option<V3StoplessCenterState>, V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled(manifest) {
        return Ok(None);
    }
    let Some(stopless_control) = stopless_control else {
        return Ok(None);
    };
    if !stopless_control.scope.has_client_session_scope() {
        return Ok(None);
    }
    stopless_control
        .control
        .load_for_scope(&stopless_control.scope)
}

fn store_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    state: V3StoplessCenterState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled(manifest) {
        return Ok(());
    }
    let Some(stopless_control) = stopless_control else {
        return Ok(());
    };
    if !stopless_control.commit_effects {
        return Ok(());
    }
    if !stopless_control.scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .control
        .store_for_scope(&stopless_control.scope, state)
}

fn clear_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled(manifest) {
        return Ok(());
    }
    let Some(stopless_control) = stopless_control else {
        return Ok(());
    };
    if !stopless_control.commit_effects {
        return Ok(());
    }
    if !stopless_control.scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .control
        .clear_for_scope(&stopless_control.scope)
}

fn apply_v3_responses_relay_stopless_control_transition(
    manifest: &V3Config05ManifestPublished,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    response_stopless_state: Option<V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    match response_stopless_state {
        Some(state) => {
            store_v3_responses_relay_stopless_control_state(manifest, stopless_control, state)
        }
        None => clear_v3_responses_relay_stopless_control_state(manifest, stopless_control),
    }
}

fn apply_v3_responses_relay_stopless_control_request_transition(
    manifest: &V3Config05ManifestPublished,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    restored_state_loaded: bool,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    match request_stopless_state {
        Some(state) => store_v3_responses_relay_stopless_control_state(
            manifest,
            stopless_control,
            state.clone(),
        ),
        None if restored_state_loaded => {
            clear_v3_responses_relay_stopless_control_state(manifest, stopless_control)
        }
        None => Ok(()),
    }
}

fn clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
    manifest: &V3Config05ManifestPublished,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if request_stopless_state.is_none() {
        return Ok(());
    }
    clear_v3_responses_relay_stopless_control_state(manifest, stopless_control)
}

#[cfg(test)]
fn build_v3_responses_provider_response_from_openai_chat_payload(
    payload: &Value,
    provider_semantic_body: &Value,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
        payload,
        provider_semantic_body,
        None,
        None,
    )
}

fn build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
    payload: &Value,
    provider_semantic_body: &Value,
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if let Some(message) = openai_chat_provider_diagnostic_message(payload) {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            message,
        ));
    }
    if let Some(message) =
        provider_response_semantic_error_message_from_manifest(manifest, provider_id, payload)
    {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            message,
        ));
    }

    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
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
            if let Some(reasoning) =
                build_v3_responses_reasoning_item_from_openai_chat_message(message)
            {
                output.push(reasoning);
            }
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
            Some("function_call" | "tool_call" | "custom_tool_call" | "tool_search_call")
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
    if let Some(model) = payload.get("model") {
        response.insert("model".to_string(), model.clone());
    }
    if let Some(created_at) = payload.get("created_at").or_else(|| payload.get("created")) {
        response.insert("created_at".to_string(), created_at.clone());
    }
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
    if let Some(usage) = payload
        .get("usage")
        .and_then(normalize_v3_hub_responses_usage_from_openai_chat_usage)
    {
        response.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(response))
}

fn openai_chat_provider_diagnostic_message(payload: &Value) -> Option<String> {
    let usage = extract_v3_runtime_usage_summary(payload);
    let usage_zero = usage.as_ref().is_some_and(|usage| {
        usage.input_tokens == Some(0)
            && usage.output_tokens == Some(0)
            && usage.total_tokens == Some(0)
    });
    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| {
            choices.iter().find_map(|choice| {
                if choice.get("finish_reason").and_then(Value::as_str) != Some("stop") {
                    return None;
                }
                let message = choice.get("message").and_then(Value::as_object)?;
                if !message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
                {
                    return None;
                }
                let content = message.get("content").and_then(Value::as_str)?.trim();
                if usage_zero && content.starts_with("upstream returned zero output tokens") {
                    return Some(
                        "OpenAI Chat provider returned zero-output upstream diagnostic instead of model output"
                            .to_string(),
                    );
                }
                None
            })
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3ProviderSemanticErrorProjection {
    code: String,
    message: String,
}

fn provider_response_semantic_error_message_from_manifest(
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
    payload: &Value,
) -> Option<String> {
    provider_response_semantic_error_from_manifest(manifest, provider_id, payload)
        .map(|error| error.message)
}

fn provider_response_semantic_error_from_manifest(
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
    payload: &Value,
) -> Option<V3ProviderSemanticErrorProjection> {
    let manifest = manifest?;
    let provider_id = provider_id?;
    let provider = manifest.providers.get(provider_id);
    let provider_type = provider.map(|provider| provider.provider_type.as_str());
    let model = payload.get("model").and_then(Value::as_str);
    manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| {
            provider_error_action_policy_matches(policy, provider_id, provider_type, model, payload)
        })
        .map(|policy| {
            let public_message = manifest
                .error
                .client_error_projection_policy
                .iter()
                .find(|projection| {
                    projection
                        .matcher
                        .reason_code
                        .as_deref()
                        .is_none_or(|reason| reason == policy.action.reason_code)
                        && projection
                            .matcher
                            .action_class
                            .is_none_or(|action| action == policy.action.kind)
                })
                .map(|projection| projection.projection.public_code.clone())
                .unwrap_or_else(|| policy.action.reason_code.clone());
            V3ProviderSemanticErrorProjection {
                code: policy.action.reason_code.clone(),
                message: format!(
                    "Provider response semantic error matched policy {} reason {} action {} display {}",
                    policy.policy_id,
                    policy.action.reason_code,
                    policy.action.kind.as_str(),
                    public_message
                ),
            }
        })
}

fn provider_error_action_policy_matches(
    policy: &V3ProviderErrorActionPolicyManifest,
    provider_id: &str,
    provider_type: Option<&str>,
    model: Option<&str>,
    payload: &Value,
) -> bool {
    if policy
        .scope
        .provider_id
        .as_deref()
        .is_some_and(|expected| expected != provider_id)
    {
        return false;
    }
    if policy
        .scope
        .provider_type
        .as_deref()
        .is_some_and(|expected| Some(expected) != provider_type)
    {
        return false;
    }
    if policy
        .scope
        .model_id
        .as_deref()
        .is_some_and(|expected| Some(expected) != model)
    {
        return false;
    }
    provider_error_matcher_matches(&policy.matcher, payload)
}

fn provider_error_matcher_matches(
    matcher: &V3ProviderErrorMatcherManifest,
    payload: &Value,
) -> bool {
    if matcher.http_status.is_some_and(|status| status != 200) {
        return false;
    }
    let usage = extract_v3_runtime_usage_summary(payload);
    if matcher.usage_total_tokens.is_some_and(|expected| {
        usage.as_ref().and_then(|usage| usage.total_tokens) != Some(expected)
    }) {
        return false;
    }
    if matcher.input_tokens.is_some_and(|expected| {
        usage.as_ref().and_then(|usage| usage.input_tokens) != Some(expected)
    }) {
        return false;
    }
    if matcher.output_tokens.is_some_and(|expected| {
        usage.as_ref().and_then(|usage| usage.output_tokens) != Some(expected)
    }) {
        return false;
    }
    let choices = payload.get("choices").and_then(Value::as_array);
    if matcher
        .choices_count
        .is_some_and(|expected| choices.map_or(0, Vec::len) != expected)
    {
        return false;
    }
    if matcher
        .finish_reason
        .as_deref()
        .is_some_and(|expected| !payload_choices_have_finish_reason(payload, expected))
    {
        return false;
    }
    if matcher
        .has_valid_model_output
        .is_some_and(|expected| provider_payload_has_valid_model_output(payload) != expected)
    {
        return false;
    }
    if !matcher.content_contains_any.is_empty()
        && !provider_payload_content_contains_any(payload, &matcher.content_contains_any)
    {
        return false;
    }
    true
}

fn payload_choices_have_finish_reason(payload: &Value, expected: &str) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|choice| choice.get("finish_reason").and_then(Value::as_str) == Some(expected))
}

fn provider_payload_has_valid_model_output(payload: &Value) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|choice| {
            let Some(message) = choice.get("message").and_then(Value::as_object) else {
                return false;
            };
            message
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|calls| !calls.is_empty())
                || message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| !content.trim().is_empty())
        })
}

fn provider_payload_content_contains_any(payload: &Value, phrases: &[String]) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.get("message").and_then(Value::as_object))
        .filter_map(|message| message.get("content").and_then(Value::as_str))
        .any(|content| phrases.iter().any(|phrase| content.contains(phrase)))
}

fn build_v3_responses_reasoning_item_from_openai_chat_message(
    message: &Map<String, Value>,
) -> Option<Value> {
    let mut summary = Vec::new();
    let mut encrypted_content = None;

    if let Some(reasoning) = message.get("reasoning") {
        if let Some(reasoning_row) = reasoning.as_object() {
            summary = collect_v3_reasoning_summary_entries(reasoning_row.get("summary"));
            if summary.is_empty() {
                summary = collect_v3_reasoning_content_entries(reasoning_row.get("content"))
                    .into_iter()
                    .map(v3_reasoning_summary_text_entry)
                    .collect();
            }
            encrypted_content = read_v3_trimmed_string(reasoning_row.get("encrypted_content"));
        } else if let Some(text) = flatten_v3_reasoning_text(reasoning)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
        {
            summary.push(v3_reasoning_summary_text_entry(text));
        }
    }

    if summary.is_empty() {
        for key in ["reasoning_content", "reasoning_text"] {
            if let Some(text) = message
                .get(key)
                .and_then(flatten_v3_reasoning_text)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
            {
                summary.push(v3_reasoning_summary_text_entry(text));
                break;
            }
        }
    }

    if summary.is_empty() && encrypted_content.is_none() {
        return None;
    }

    let mut item = Map::new();
    item.insert("type".to_string(), Value::String("reasoning".to_string()));
    if !summary.is_empty() {
        item.insert("summary".to_string(), Value::Array(summary));
    }
    if let Some(encrypted_content) = encrypted_content {
        item.insert(
            "encrypted_content".to_string(),
            Value::String(encrypted_content),
        );
    }
    Some(Value::Object(item))
}

fn collect_v3_reasoning_summary_entries(value: Option<&Value>) -> Vec<Value> {
    collect_v3_reasoning_text_entries(value, Some("summary_text"))
        .into_iter()
        .map(v3_reasoning_summary_text_entry)
        .collect()
}

fn collect_v3_reasoning_content_entries(value: Option<&Value>) -> Vec<String> {
    collect_v3_reasoning_text_entries(value, Some("reasoning_text"))
}

fn collect_v3_reasoning_text_entries(
    value: Option<&Value>,
    expected_type: Option<&str>,
) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(text) => trimmed_v3_text(text).into_iter().collect(),
        Value::Array(entries) => entries
            .iter()
            .flat_map(|entry| collect_v3_reasoning_text_entries(Some(entry), expected_type))
            .collect(),
        Value::Object(row) => {
            if let Some(expected_type) = expected_type {
                let kind = row
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(expected_type)
                    .trim()
                    .to_ascii_lowercase();
                if kind != expected_type && kind != "text" {
                    return Vec::new();
                }
            }
            row.get("text")
                .or_else(|| row.get("content"))
                .and_then(flatten_v3_reasoning_text)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

fn flatten_v3_reasoning_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => trimmed_v3_text(text),
        Value::Array(entries) => {
            let mut joined = String::new();
            for text in entries
                .iter()
                .filter_map(flatten_v3_reasoning_text)
                .filter(|text| !text.trim().is_empty())
            {
                if !joined.is_empty() {
                    joined.push('\n');
                }
                joined.push_str(text.trim());
            }
            trimmed_v3_text(joined.as_str())
        }
        Value::Object(row) => row
            .get("text")
            .or_else(|| row.get("content"))
            .and_then(flatten_v3_reasoning_text),
        _ => None,
    }
}

fn trimmed_v3_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn v3_reasoning_summary_text_entry(text: String) -> Value {
    json!({"type":"summary_text","text":text})
}

fn normalize_v3_hub_responses_usage_from_openai_chat_usage(usage: &Value) -> Option<Value> {
    let source = usage.as_object()?;
    let mut response = Map::new();
    if let Some(value) = source
        .get("input_tokens")
        .or_else(|| source.get("prompt_tokens"))
        .cloned()
    {
        response.insert("input_tokens".to_string(), value);
    }
    if let Some(value) = source
        .get("output_tokens")
        .or_else(|| source.get("completion_tokens"))
        .cloned()
    {
        response.insert("output_tokens".to_string(), value);
    }
    if let Some(value) = source.get("total_tokens").cloned() {
        response.insert("total_tokens".to_string(), value);
    }
    if let Some(details) = source
        .get("input_tokens_details")
        .or_else(|| source.get("prompt_tokens_details"))
        .cloned()
    {
        response.insert("input_tokens_details".to_string(), details);
    }
    if let Some(details) = source
        .get("output_tokens_details")
        .or_else(|| source.get("completion_tokens_details"))
        .cloned()
    {
        response.insert("output_tokens_details".to_string(), details);
    }
    (!response.is_empty()).then_some(Value::Object(response))
}

fn build_v3_responses_function_call_from_openai_chat_tool_call(
    call: &Value,
    custom_tool_names: &BTreeSet<String>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let object = call.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat tool_call must be an object before Responses projection".to_string(),
        )
    })?;
    let function = object
        .get("function")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat tool_call.function must be an object before Responses projection"
                    .to_string(),
            )
        })?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
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
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
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
    if name == "tool_search" {
        let arguments = parse_v3_openai_chat_tool_call_arguments_object(name, arguments)?;
        return Ok(json!({
            "type":"tool_search_call",
            "call_id":call_id,
            "execution":"client",
            "arguments":arguments
        }));
    }
    if name == "web_search" {
        let action = build_v3_responses_web_search_action_from_openai_chat_arguments(arguments)?;
        return Ok(json!({
            "type":"web_search_call",
            "id":call_id,
            "status":"completed",
            "action":action
        }));
    }
    Ok(json!({
        "type":"function_call",
        "call_id":call_id,
        "name":name,
        "arguments":arguments
    }))
}

fn parse_v3_openai_chat_tool_call_arguments_object(
    name: &str,
    arguments: &str,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let trimmed = arguments.trim();
    let parsed = if trimmed.is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str::<Value>(trimmed).map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "OpenAI Chat tool_call {name} arguments must be a JSON object before Responses projection: {error}"
            ))
        })?
    };
    if parsed.is_object() {
        return Ok(parsed);
    }
    Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
        format!(
            "OpenAI Chat tool_call {name} arguments must be a JSON object before Responses projection"
        ),
    ))
}

fn build_v3_responses_web_search_action_from_openai_chat_arguments(
    arguments: &str,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let parsed = parse_v3_openai_chat_tool_call_arguments_object("web_search", arguments)?;
    let object = parsed.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat web_search arguments must be a JSON object before Responses projection"
                .to_string(),
        )
    })?;
    let action = object
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if object.get("url").and_then(Value::as_str).is_some() {
                if object.get("pattern").and_then(Value::as_str).is_some() {
                    "find_in_page"
                } else {
                    "open_page"
                }
            } else {
                "search"
            }
        });
    match action {
        "open_page" => Ok(json!({
            "type":"open_page",
            "url": object.get("url").and_then(Value::as_str).unwrap_or_default()
        })),
        "find_in_page" => Ok(json!({
            "type":"find_in_page",
            "url": object.get("url").and_then(Value::as_str).unwrap_or_default(),
            "pattern": object.get("pattern").and_then(Value::as_str).unwrap_or_default()
        })),
        _ => {
            let query = object
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut action = Map::from_iter([
                ("type".to_string(), Value::String("search".to_string())),
                ("query".to_string(), Value::String(query.to_string())),
            ]);
            if let Some(queries) = object.get("queries").and_then(Value::as_array) {
                action.insert("queries".to_string(), Value::Array(queries.clone()));
            }
            Ok(Value::Object(action))
        }
    }
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
    let parsed: Value = match serde_json::from_str(arguments) {
        Ok(parsed) => parsed,
        Err(error) => {
            if let Some(input) =
                extract_v3_responses_custom_tool_input_from_relaxed_openai_chat_arguments(arguments)
            {
                return Ok(input);
            }
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!(
                    "OpenAI Chat custom tool_call {name} arguments must be JSON object with string input before Responses projection: {error}"
                ),
            ));
        }
    };
    let object = parsed.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
            "OpenAI Chat custom tool_call {name} arguments must be JSON object before Responses projection"
        ))
    })?;
    object
        .get("input")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "OpenAI Chat custom tool_call {name} arguments.input must be string before Responses projection"
            ))
        })
}

fn extract_v3_responses_custom_tool_input_from_relaxed_openai_chat_arguments(
    arguments: &str,
) -> Option<String> {
    let trimmed = arguments.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return None;
    }
    let key = "\"input\"";
    let key_start = trimmed.find(key)?;
    if !trimmed[1..key_start].trim().is_empty() {
        return None;
    }
    let after_key_start = key_start + key.len();
    let after_key = &trimmed[after_key_start..];
    let colon_offset = after_key.find(':')?;
    if !after_key[..colon_offset].trim().is_empty() {
        return None;
    }
    let after_colon_start = after_key_start + colon_offset + 1;
    let after_colon = &trimmed[after_colon_start..];
    let value_ws_len = after_colon.len() - after_colon.trim_start().len();
    let opening_quote = after_colon_start + value_ws_len;
    if trimmed.as_bytes().get(opening_quote) != Some(&b'"') {
        return None;
    }
    let end_brace = trimmed.rfind('}')?;
    let before_end_brace = &trimmed[..end_brace];
    let closing_quote = before_end_brace.rfind('"')?;
    if closing_quote <= opening_quote {
        return None;
    }
    if !trimmed[closing_quote + 1..end_brace].trim().is_empty() {
        return None;
    }
    decode_v3_relaxed_json_string_content(&trimmed[opening_quote + 1..closing_quote])
}

fn decode_v3_relaxed_json_string_content(content: &str) -> Option<String> {
    let mut output = String::with_capacity(content.len());
    let mut chars = content.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }
        let escaped = chars.next()?;
        match escaped {
            '"' => output.push('"'),
            '\\' => output.push('\\'),
            '/' => output.push('/'),
            'b' => output.push('\u{0008}'),
            'f' => output.push('\u{000c}'),
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            'u' => {
                let mut hex = String::with_capacity(4);
                for _ in 0..4 {
                    hex.push(chars.next()?);
                }
                let code = u32::from_str_radix(&hex, 16).ok()?;
                output.push(char::from_u32(code)?);
            }
            other => {
                output.push('\\');
                output.push(other);
            }
        }
    }
    Some(output)
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
        provider_failure_events: Vec::new(),
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

fn v3_responses_relay_transport_intent_from_stream_field(payload: &Value) -> V3HubTransportIntent {
    if payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    }
}

fn validate_v3_responses_relay_provider_request_transport_intent(
    expected: V3HubTransportIntent,
    actual: V3ResponsesStreamIntent,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let actual = match actual {
        V3ResponsesStreamIntent::Json => V3HubTransportIntent::Json,
        V3ResponsesStreamIntent::Sse => V3HubTransportIntent::Sse,
    };
    if actual == expected {
        return Ok(());
    }
    Err(V3ResponsesRelayRuntimeError::ProviderWireEncoding(format!(
        "Responses Relay provider request transport intent mismatch: expected {} but built {}",
        v3_transport_intent_label(expected),
        v3_transport_intent_label(actual)
    )))
}

fn project_v3_responses_relay_client_body(
    client_response_transport_intent: V3HubTransportIntent,
    finalized_response: Value,
) -> V3ResponsesRelayClientBody {
    match client_response_transport_intent {
        V3HubTransportIntent::Json => V3ResponsesRelayClientBody::Json(finalized_response),
        V3HubTransportIntent::Sse => V3ResponsesRelayClientBody::Sse(
            build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(finalized_response),
        ),
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
                V3_RESPONSES_RELAY_PROVIDER_EVENT_FAILED_MESSAGE
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
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    terminal_response.ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            V3_RESPONSES_RELAY_PROVIDER_EVENT_EOF_WITHOUT_TERMINAL_MESSAGE.to_string(),
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
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events(
                provider,
                observation,
            )
            .await
        }
        other => Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            format!("Responses relay cannot decode provider stream protocol {other:?}"),
        )),
    }
}

#[derive(Default)]
struct V3AnthropicProviderStreamBlock {
    kind: Option<String>,
    id: Option<String>,
    name: Option<String>,
    text: String,
    encrypted_content: Option<String>,
    input: Option<Value>,
    input_json_delta: String,
    stopped: bool,
}

#[derive(Default)]
struct V3AnthropicProviderStreamState {
    message: Map<String, Value>,
    content_blocks: BTreeMap<usize, V3AnthropicProviderStreamBlock>,
    usage: Map<String, Value>,
    message_start_seen: bool,
    message_stop_seen: bool,
}

pub(crate) async fn build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut state = V3AnthropicProviderStreamState::default();
    let mut done_seen = false;
    while let Some(chunk) = provider.next().await {
        let chunk = chunk?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string())
            })?;
        for frame in frames {
            let Some((_event_type, data)) = parse_v3_runtime_sse_frame_fields(&frame)? else {
                continue;
            };
            if data == "[DONE]" {
                if !state.message_stop_seen {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream emitted [DONE] before message_stop"
                            .to_string(),
                    ));
                }
                done_seen = true;
                continue;
            }
            if done_seen || state.message_stop_seen {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "Anthropic provider event stream emitted data after message_stop".to_string(),
                ));
            }
            let event: Value = serde_json::from_str(&data).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "Anthropic provider event stream event is malformed: {error}"
                ))
            })?;
            if let Some(message) = extract_v3_provider_event_error_payload_message(&event) {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    message,
                ));
            }
            characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
                event.clone(),
                V3HubProviderWireProtocol::Anthropic,
                V3HubTransportIntent::Sse,
            )
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
            collect_v3_anthropic_provider_stream_event(event, &mut state)?;
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    if !state.message_stop_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream ended without message_stop".to_string(),
        ));
    }
    let anthropic_message = build_v3_anthropic_message_from_provider_stream_state(state)?;
    let response = project_v3_anthropic_message_as_responses_response(&anthropic_message).map_err(
        |error| V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string()),
    )?;
    observation
        .record_event(&response)
        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
    Ok(response)
}

fn collect_v3_anthropic_provider_stream_event(
    event: Value,
    state: &mut V3AnthropicProviderStreamState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let event_object = event.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream event must be an object".to_string(),
        )
    })?;
    let event_type = event_object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "Anthropic provider event stream event missing type".to_string(),
            )
        })?;
    match event_type {
        "message_start" => {
            if state.message_start_seen {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "Anthropic provider event stream emitted duplicate message_start".to_string(),
                ));
            }
            let message = event_object
                .get("message")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream message_start missing message object"
                            .to_string(),
                    )
                })?;
            for key in [
                "id",
                "type",
                "role",
                "model",
                "stop_reason",
                "stop_sequence",
            ] {
                if let Some(value) = message.get(key) {
                    state.message.insert(key.to_string(), value.clone());
                }
            }
            merge_v3_anthropic_provider_stream_usage(&mut state.usage, message.get("usage"))?;
            state.message_start_seen = true;
        }
        "content_block_start" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            let index = read_v3_anthropic_provider_stream_index(event_object, event_type)?;
            if state.content_blocks.contains_key(&index) {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream content_block_start duplicated index {index}"
                    ),
                ));
            }
            let content_block = event_object
                .get("content_block")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream content_block_start missing content_block object"
                            .to_string(),
                    )
                })?;
            let kind = read_v3_trimmed_string(content_block.get("type")).ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "Anthropic provider event stream content_block_start missing content_block.type"
                        .to_string(),
                )
            })?;
            let mut block = V3AnthropicProviderStreamBlock {
                kind: Some(kind.clone()),
                id: read_v3_trimmed_string(content_block.get("id")),
                name: read_v3_trimmed_string(content_block.get("name")),
                encrypted_content: read_v3_trimmed_string(content_block.get("encrypted_content"))
                    .or_else(|| read_v3_trimmed_string(content_block.get("signature")))
                    .or_else(|| read_v3_trimmed_string(content_block.get("data"))),
                input: content_block.get("input").cloned(),
                ..V3AnthropicProviderStreamBlock::default()
            };
            match kind.as_str() {
                "text" => {
                    if let Some(text) = content_block.get("text").and_then(Value::as_str) {
                        block.text.push_str(text);
                    }
                }
                "thinking" | "reasoning" | "redacted_thinking" => {
                    if let Some(thinking) = content_block
                        .get("thinking")
                        .or_else(|| content_block.get("text"))
                        .and_then(Value::as_str)
                    {
                        block.text.push_str(thinking);
                    }
                }
                "tool_use" => {}
                other => {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        format!(
                            "Anthropic provider event stream content block type {other} is unsupported"
                        ),
                    ));
                }
            }
            state.content_blocks.insert(index, block);
        }
        "content_block_delta" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            let index = read_v3_anthropic_provider_stream_index(event_object, event_type)?;
            let block = state.content_blocks.get_mut(&index).ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "Anthropic provider event stream content_block_delta missing start for index {index}"
                ))
            })?;
            if block.stopped {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream content_block_delta followed stop for index {index}"
                    ),
                ));
            }
            let delta = event_object
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream content_block_delta missing delta object"
                            .to_string(),
                    )
                })?;
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    let text = delta.get("text").and_then(Value::as_str).ok_or_else(|| {
                        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            "Anthropic provider event stream text_delta missing text".to_string(),
                        )
                    })?;
                    block.text.push_str(text);
                }
                Some("thinking_delta") => {
                    let thinking = delta
                        .get("thinking")
                        .or_else(|| delta.get("text"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic provider event stream thinking_delta missing thinking/text"
                                    .to_string(),
                            )
                        })?;
                    block.text.push_str(thinking);
                }
                Some("input_json_delta") => {
                    let partial_json = delta
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic provider event stream input_json_delta missing partial_json"
                                    .to_string(),
                            )
                        })?;
                    block.input_json_delta.push_str(partial_json);
                }
                Some("signature_delta") => {
                    if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                        let current = block.encrypted_content.get_or_insert_with(String::new);
                        current.push_str(signature);
                    }
                }
                Some("citations_delta") => {}
                Some(other) => {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        format!(
                            "Anthropic provider event stream delta type {other} is unsupported"
                        ),
                    ));
                }
                None => {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream content_block_delta missing delta.type"
                            .to_string(),
                    ));
                }
            }
        }
        "content_block_stop" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            let index = read_v3_anthropic_provider_stream_index(event_object, event_type)?;
            let block = state.content_blocks.get_mut(&index).ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "Anthropic provider event stream content_block_stop missing start for index {index}"
                ))
            })?;
            if block.stopped {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream duplicated content_block_stop for index {index}"
                    ),
                ));
            }
            block.stopped = true;
        }
        "message_delta" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            if let Some(delta) = event_object.get("delta").and_then(Value::as_object) {
                for key in ["stop_reason", "stop_sequence"] {
                    if let Some(value) = delta.get(key) {
                        state.message.insert(key.to_string(), value.clone());
                    }
                }
            }
            merge_v3_anthropic_provider_stream_usage(&mut state.usage, event_object.get("usage"))?;
        }
        "message_stop" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            state.message_stop_seen = true;
        }
        "ping" => {}
        "error" => {
            let message = event
                .pointer("/error/message")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
                .unwrap_or("Anthropic provider event stream emitted an error event");
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message.to_string(),
            ));
        }
        other => {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!("Anthropic provider event stream event type {other} is unsupported"),
            ));
        }
    }
    Ok(())
}

fn require_v3_anthropic_provider_message_start(
    state: &V3AnthropicProviderStreamState,
    event_type: &str,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if state.message_start_seen {
        Ok(())
    } else {
        Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            format!("Anthropic provider event stream emitted {event_type} before message_start"),
        ))
    }
}

fn read_v3_anthropic_provider_stream_index(
    event: &Map<String, Value>,
    event_type: &str,
) -> Result<usize, V3ResponsesRelayRuntimeError> {
    event
        .get("index")
        .and_then(Value::as_u64)
        .map(|index| index as usize)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "Anthropic provider event stream {event_type} missing index"
            ))
        })
}

fn merge_v3_anthropic_provider_stream_usage(
    target: &mut Map<String, Value>,
    usage: Option<&Value>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(usage) = usage else {
        return Ok(());
    };
    let usage = usage.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream usage must be an object".to_string(),
        )
    })?;
    for (key, value) in usage {
        target.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn build_v3_anthropic_message_from_provider_stream_state(
    mut state: V3AnthropicProviderStreamState,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if !state.message_start_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream response missing message_start".to_string(),
        ));
    }
    let mut content = Vec::with_capacity(state.content_blocks.len());
    for (index, block) in state.content_blocks {
        if !block.stopped {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!(
                    "Anthropic provider event stream content block {index} ended without content_block_stop"
                ),
            ));
        }
        match block.kind.as_deref() {
            Some("text") => content.push(json!({
                "type":"text",
                "text":block.text
            })),
            Some("thinking" | "reasoning") => {
                let mut item = json!({
                    "type":"thinking",
                    "thinking":block.text
                });
                if let Some(encrypted_content) = block.encrypted_content {
                    item["signature"] = Value::String(encrypted_content);
                }
                content.push(item);
            }
            Some("redacted_thinking") => {
                let encrypted_content = block.encrypted_content.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "Anthropic provider event stream redacted_thinking block {index} missing data"
                    ))
                })?;
                content.push(json!({
                    "type":"redacted_thinking",
                    "data":encrypted_content
                }));
            }
            Some("tool_use") => {
                let id = block.id.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "Anthropic provider event stream tool_use block {index} missing id"
                    ))
                })?;
                let name = block.name.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "Anthropic provider event stream tool_use block {index} missing name"
                    ))
                })?;
                let input = if block.input_json_delta.is_empty() {
                    block.input.unwrap_or_else(|| Value::Object(Map::new()))
                } else {
                    serde_json::from_str::<Value>(&block.input_json_delta).map_err(|error| {
                        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                            "Anthropic provider event stream tool_use block {index} input_json_delta is malformed: {error}"
                        ))
                    })?
                };
                if !input.is_object() {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        format!(
                            "Anthropic provider event stream tool_use block {index} input must be an object"
                        ),
                    ));
                }
                content.push(json!({
                    "type":"tool_use",
                    "id":id,
                    "name":name,
                    "input":input
                }));
            }
            Some(other) => {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream content block type {other} is unsupported"
                    ),
                ));
            }
            None => {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!("Anthropic provider event stream content block {index} missing type"),
                ));
            }
        }
    }
    state
        .message
        .entry("type".to_string())
        .or_insert_with(|| Value::String("message".to_string()));
    state
        .message
        .entry("role".to_string())
        .or_insert_with(|| Value::String("assistant".to_string()));
    state
        .message
        .insert("content".to_string(), Value::Array(content));
    if !state.usage.is_empty() {
        state
            .message
            .insert("usage".to_string(), Value::Object(state.usage));
    }
    Ok(Value::Object(state.message))
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
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string())
            })?;
        for frame in frames {
            let Some((_event_type, data)) = parse_v3_runtime_sse_frame_fields(&frame)? else {
                continue;
            };
            if data == "[DONE]" {
                if !terminal_seen {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "OpenAI Chat provider event stream emitted [DONE] before terminal finish_reason"
                            .to_string(),
                    ));
                }
                done_seen = true;
                continue;
            }
            if done_seen {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat provider event stream emitted data after [DONE]".to_string(),
                ));
            }
            let event: Value = serde_json::from_str(&data).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "OpenAI Chat provider event stream event is malformed: {error}"
                ))
            })?;
            if let Some(message) = extract_v3_provider_event_error_payload_message(&event) {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    message,
                ));
            }
            if terminal_seen && is_v3_openai_chat_empty_sse_tail_sentinel(&event) {
                continue;
            }
            validate_v3_openai_chat_provider_response_payload(
                &event,
                V3HubProviderWireProtocol::OpenAiChat,
                V3HubTransportIntent::Sse,
            )
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
            observation
                .record_event(&event)
                .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
            collect_openai_chat_stream_event(
                event,
                V3OpenAiChatStreamCollectionState {
                    response_id: &mut response_id,
                    model: &mut model,
                    created: &mut created,
                    usage: &mut usage,
                    choices: &mut choices,
                    terminal_seen: &mut terminal_seen,
                    observation,
                },
            )?;
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    if !terminal_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat provider event stream ended without terminal finish_reason".to_string(),
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

struct V3OpenAiChatStreamCollectionState<'a> {
    response_id: &'a mut Option<String>,
    model: &'a mut Option<String>,
    created: &'a mut Option<Value>,
    usage: &'a mut Option<Value>,
    choices: &'a mut BTreeMap<usize, V3OpenAiChatStreamChoice>,
    terminal_seen: &'a mut bool,
    observation: &'a V3RuntimeStreamObservation,
}

fn collect_openai_chat_stream_event(
    event: Value,
    state: V3OpenAiChatStreamCollectionState<'_>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let event_object = event.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat provider event stream event must be an object".to_string(),
        )
    })?;
    if state.response_id.is_none() {
        *state.response_id = read_v3_trimmed_string(event_object.get("id"));
    }
    if state.model.is_none() {
        *state.model = read_v3_trimmed_string(event_object.get("model"));
    }
    if state.created.is_none() {
        *state.created = event_object.get("created").cloned();
    }
    if let Some(next_usage) = event_object.get("usage").filter(|value| !value.is_null()) {
        *state.usage = Some(next_usage.clone());
    }
    let Some(event_choices) = event_object.get("choices").and_then(Value::as_array) else {
        return Ok(());
    };
    for choice_value in event_choices {
        let choice_object = choice_value.as_object().ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat provider event stream choice must be an object".to_string(),
            )
        })?;
        let index = choice_object
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let choice = state.choices.entry(index).or_default();
        if let Some(finish_reason) = choice_object
            .get("finish_reason")
            .filter(|value| !value.is_null())
        {
            choice.finish_reason = Some(finish_reason.clone());
            *state.terminal_seen = true;
            if let Some(reason) = finish_reason.as_str() {
                state
                    .observation
                    .record_finish_reason(reason)
                    .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
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
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat provider event stream tool_call delta must be an object".to_string(),
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
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat provider event stream response did not contain choices".to_string(),
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
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "OpenAI Chat provider event stream tool_call[{tool_index}] missing id"
                    ))
                })?;
                let function_name = tool_call.function_name.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "OpenAI Chat provider event stream tool_call[{tool_index}] missing function.name"
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
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    let mut terminal_response = None;
    for frame in frames {
        let Some((event_type, data)) = parse_v3_runtime_sse_frame_fields(&frame)? else {
            continue;
        };
        if data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(&data).map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "V3 Responses Relay response event payload is malformed: {error}"
            ))
        })?;
        if let Some(message) = extract_v3_provider_event_error_payload_message(&event) {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message,
            ));
        }
        observation
            .record_event(&event)
            .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
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
                    .unwrap_or(V3_RESPONSES_RELAY_PROVIDER_EVENT_FAILED_MESSAGE);
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
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
        if let Some(message) = extract_v3_provider_event_error_message_from_sse_frame(frame) {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message,
            ));
        }
        return Ok(None);
    }
    Ok(Some((event_type, data.to_string())))
}

fn extract_v3_provider_event_error_message_from_sse_frame(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
) -> Option<String> {
    let raw = reconstruct_v3_runtime_sse_frame_text(frame)?;
    let payload = serde_json::from_str::<Value>(&raw).ok()?;
    extract_v3_provider_event_error_payload_message(&payload)
}

fn reconstruct_v3_runtime_sse_frame_text(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
) -> Option<String> {
    let mut lines = Vec::new();
    for field in frame.frame().fields() {
        match field {
            SseField::Comment(value) => lines.push(format!(":{value}")),
            SseField::Named { name, value } if value.is_empty() => lines.push(name.clone()),
            SseField::Named { name, value } => lines.push(format!("{name}: {value}")),
        }
    }
    let text = lines.join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn extract_v3_provider_event_error_payload_message(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    match error {
        Value::Object(error) => {
            let message = read_v3_trimmed_string(error.get("message"))
                .or_else(|| read_v3_trimmed_string(error.get("error")))
                .or_else(|| read_v3_trimmed_string(error.get("detail")));
            let error_type = read_v3_trimmed_string(error.get("type"))
                .or_else(|| read_v3_trimmed_string(error.get("code")));
            match (error_type, message) {
                (Some(error_type), Some(message)) => {
                    Some(format!("provider event error {error_type}: {message}"))
                }
                (Some(error_type), None) => Some(format!("provider event error {error_type}")),
                (None, Some(message)) => Some(format!("provider event error: {message}")),
                (None, None) => None,
            }
        }
        Value::String(message) => {
            let message = message.trim();
            (!message.is_empty()).then(|| format!("provider event error: {message}"))
        }
        _ => None,
    }
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
                upsert_v3_runtime_responses_event_output_item(output_items, item);
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
                append_v3_runtime_responses_event_function_arguments(output_items, event, delta);
            }
        }
        Some("response.function_call_arguments.done") => {
            if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                set_v3_runtime_responses_event_function_arguments(output_items, event, arguments);
            }
        }
        _ => {}
    }
}

fn upsert_v3_runtime_responses_event_output_item(output_items: &mut Vec<Value>, item: Value) {
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

fn append_v3_runtime_responses_event_function_arguments(
    output_items: &mut [Value],
    event: &Value,
    delta: &str,
) {
    let Some(item) = find_v3_runtime_responses_event_function_item_mut(output_items, event) else {
        return;
    };
    let current = item
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    item["arguments"] = Value::String(format!("{current}{delta}"));
}

fn set_v3_runtime_responses_event_function_arguments(
    output_items: &mut [Value],
    event: &Value,
    arguments: &str,
) {
    if let Some(item) = find_v3_runtime_responses_event_function_item_mut(output_items, event) {
        item["arguments"] = Value::String(arguments.to_string());
    }
}

fn find_v3_runtime_responses_event_function_item_mut<'items>(
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
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "V3 Responses Relay response event terminal response must be an object".to_string(),
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
    let failed = matches!(
        response.get("status").and_then(Value::as_str),
        Some("failed" | "incomplete")
    );
    let mut frames = Vec::new();
    if !failed {
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
    if failed {
        frames.push(Ok(build_v3_runtime_sse_json_frame(
            "response.failed",
            &json!({
                "type": "response.failed",
                "response": response,
            }),
        )));
    } else {
        frames.push(Ok(build_v3_runtime_sse_json_frame(
            "response.completed",
            &json!({
                "type": "response.completed",
                "response": response.clone(),
            }),
        )));
        frames.push(Ok(build_v3_runtime_sse_json_frame(
            "response.done",
            &json!({
                "type": "response.done",
                "response": response,
            }),
        )));
    }
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

fn provider_semantic_failure(
    status: u16,
    error: V3ProviderSemanticErrorProjection,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    V3ResponsesRelayProviderFailure {
        status,
        client_response: json!({
            "error": {
                "type": "provider_semantic_error",
                "code": error.code,
                "message": error.message,
            }
        }),
        provider_id: provider_id.to_string(),
        observability,
    }
}

fn provider_response_stream_failure(
    error: V3ResponsesRelayRuntimeError,
    request_id: &str,
    provider_id: &str,
) -> V3ProviderError {
    match error {
        V3ResponsesRelayRuntimeError::Provider(error) => error,
        V3ResponsesRelayRuntimeError::ProviderSseTransport(reason) => {
            V3ProviderError::MalformedSse {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                reason: format!("provider SSE transport failed: {reason}"),
            }
        }
        other => V3ProviderError::ResponseBody {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: format!("provider response event codec failed: {other}"),
        },
    }
}

fn is_v3_responses_provider_response_failure(error: &V3ResponsesRelayRuntimeError) -> bool {
    matches!(
        error,
        V3ResponsesRelayRuntimeError::Provider(_)
            | V3ResponsesRelayRuntimeError::ProviderJson(_)
            | V3ResponsesRelayRuntimeError::ProviderSseTransport(_)
            | V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(_)
    )
}

fn provider_response_hook_failure(
    error: V3ResponsesRelayRuntimeError,
    request_id: &str,
    provider_id: &str,
) -> V3ProviderError {
    match error {
        V3ResponsesRelayRuntimeError::Provider(error) => error,
        other => V3ProviderError::ResponseBody {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: format!("provider response event codec failed: {other}"),
        },
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
    let _ = client_response;
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        candidates_remaining,
        source_status: Some(status),
    });
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
        status: projected.status,
        client_body: V3ResponsesRelayClientBody::Json(projected.body),
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
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use serde_json::json;

    fn glmrelay_error_policy_manifest() -> V3Config05ManifestPublished {
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3

[[error.provider_error_action_policy]]
policy_id = "glmrelay_openai_200_diagnostic_zero_usage"
[error.provider_error_action_policy.scope]
provider_id = "glmrelay_openai"
provider_type = "openai_chat"
[error.provider_error_action_policy.match]
http_status = 200
[error.provider_error_action_policy.match.sse]
finish_reason = "stop"
usage_total_tokens = 0
content_contains_any = ["mac超负荷运载，应该是挂了"]
[error.provider_error_action_policy.action]
kind = "periodic_recovery"
reason_code = "provider_diagnostic_zero_usage"
retry_mode = "reselect_before_client_projection"
cooldown_ms = 300000
disable_scope = "provider_model"

[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]

[providers.glmrelay_openai]
type = "openai_chat"
base_url = "https://glm-relayapi.top/v1"
default_model = "glm-5.2"
auth = { type = "api_key", entries = [{ alias = "key1", env = "GLM_TEST_KEY" }] }

[providers.glmrelay_openai.models."glm-5.2"]
capabilities = ["text", "reasoning", "tools"]

[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "glmrelay_openai", model = "glm-5.2", key = "key1", priority = 1 }]
"#,
            )
            .expect("config authoring"),
        )
        .expect("manifest")
    }

    #[test]
    fn target_selection_sample_is_stable_per_request_and_spans_weighted_buckets() {
        let request_id = "openai-responses-router-gpt-5.5-20260722T143237284-597520-4987";
        assert_eq!(
            v3_relay_provider_target_selection_sample(request_id),
            v3_relay_provider_target_selection_sample(request_id)
        );

        let buckets = (0..32)
            .map(|index| {
                v3_relay_provider_target_selection_sample(&format!("weighted-lb-{index}")) % 2
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            buckets,
            BTreeSet::from([0, 1]),
            "request-id sampling must not pin a two-target weighted pool to one provider"
        );
    }

    #[tokio::test]
    async fn responses_relay_routes_reasoning_from_original_responses_surface_after_chat_canonicalization(
    ) {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]

[providers.glm]
type = "openai_chat"
base_url = "https://glm.example/v1"
default_model = "glm-5.2"
auth = { type = "api_key", entries = [{ alias = "key1", env = "GLM_TEST_KEY" }] }
[providers.glm.models."glm-5.2"]
capabilities = ["text", "reasoning", "tools"]

[providers.minimax]
type = "openai_chat"
base_url = "https://minimax.example/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_TEST_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
capabilities = ["text", "tools"]

[route_groups.g.pools.thinking]
selection = { strategy = "priority" }
match = { precedence = 1, entry_protocol = "responses", required_capabilities = ["reasoning"] }
targets = [{ kind = "provider_model", provider = "glm", model = "glm-5.2", key = "key1", priority = 1 }]

[route_groups.g.pools.default]
selection = { strategy = "weighted" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", weight = 1 }]
"#,
        )
        .expect("config authoring");
        let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
        let output = execute_v3_responses_relay_dry_run_runtime(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "s".to_string(),
                request_id: "req_reasoning_original_surface_route".to_string(),
                payload: json!({
                    "model": "gpt-5.5",
                    "input": [{"type":"message","role":"user","content":"think deeply"}],
                    "reasoning": {"effort": "high"},
                    "stream": true
                }),
            },
        )
        .await;

        assert_eq!(output.status, 200);
        assert_eq!(output.body["evidence"]["providerNetworkSend"], false);
        assert_eq!(output.body["providerRequest"]["providerId"], "glm");
        assert_eq!(output.body["providerRequest"]["body"]["model"], "glm-5.2");
    }

    #[test]
    fn openai_chat_tool_search_function_call_projects_to_responses_tool_search_call() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id":"chatcmpl_tool_search_call",
                "choices":[{
                    "message":{
                        "role":"assistant",
                        "content":"",
                        "tool_calls":[{
                            "id":"call_search_tools",
                            "type":"function",
                            "function":{
                                "name":"tool_search",
                                "arguments":"{\"query\":\"ssh-manager\",\"limit\":8}"
                            }
                        }]
                    },
                    "finish_reason":"tool_calls"
                }]
            }),
            &json!({
                "tools":[{
                    "type":"function",
                    "function":{
                        "name":"tool_search",
                        "parameters":{"type":"object"}
                    }
                }]
            }),
        )
        .expect("OpenAI Chat function tool_search must project back to Responses tool_search_call");

        assert_eq!(response["status"], "requires_action");
        assert_eq!(response["output"][0]["type"], "tool_search_call");
        assert_eq!(response["output"][0]["call_id"], "call_search_tools");
        assert_eq!(response["output"][0]["execution"], "client");
        assert_eq!(response["output"][0]["arguments"]["query"], "ssh-manager");
        assert_eq!(response["output"][0]["arguments"]["limit"], 8);
        assert!(
            !serde_json::to_string(&response)
                .unwrap()
                .contains("function_call"),
            "tool_search must not return to Codex as a generic function_call: {response}"
        );
    }

    #[test]
    fn openai_chat_web_search_function_call_projects_to_responses_web_search_call() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id":"chatcmpl_web_search_call",
                "choices":[{
                    "message":{
                        "role":"assistant",
                        "content":"",
                        "tool_calls":[{
                            "id":"call_web_search",
                            "type":"function",
                            "function":{
                                "name":"web_search",
                                "arguments":"{\"query\":\"RouteCodex docs\"}"
                            }
                        }]
                    },
                    "finish_reason":"tool_calls"
                }]
            }),
            &json!({"tools":[{"type":"function","function":{"name":"web_search"}}]}),
        )
        .expect("OpenAI Chat function web_search must project back to Responses web_search_call");

        assert_eq!(response["output"][0]["type"], "web_search_call");
        assert_eq!(response["output"][0]["id"], "call_web_search");
        assert_eq!(response["output"][0]["status"], "completed");
        assert_eq!(response["output"][0]["action"]["type"], "search");
        assert_eq!(response["output"][0]["action"]["query"], "RouteCodex docs");
    }

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
    fn openai_chat_zero_output_upstream_diagnostic_is_provider_error() {
        let error = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_zero_output_diagnostic",
                "model": "glm-5.2",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "upstream returned zero output tokens, input_tokens=76100",
                        "reasoning_content": "Let me rethink this one step at a time."
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                    "input_tokens": 0,
                    "output_tokens": 0
                }
            }),
            &json!({
                "tools": [{"type":"function","function":{"name":"exec_command"}}]
            }),
        )
        .expect_err("zero-output upstream diagnostic must be provider failure, not success");

        assert!(
            error
                .to_string()
                .contains("zero-output upstream diagnostic"),
            "wrong error: {error}"
        );
    }

    #[tokio::test]
    async fn openai_chat_zero_output_stream_diagnostic_is_provider_error() {
        let observation = V3RuntimeStreamObservation::default();
        let raw_sse = concat!(
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"reasoning_content\":\"Let me rethink this one step at a time.\\n\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"content\":\"upstream returned zero output tokens, input_tokens=76100\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_zero_output_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784812451,\"model\":\"glm-5.2\",\"choices\":[],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0,\"input_tokens\":0,\"output_tokens\":0,\"completion_tokens_details\":{\"reasoning_tokens\":0}}}\n\n",
            "data: [DONE]\n\n",
        );
        let provider = Box::pin(stream::iter(vec![Ok(raw_sse.as_bytes().to_vec())]));
        let provider_payload =
            build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
                provider,
                &observation,
            )
            .await
            .expect("stream diagnostic materializes before semantic projection");

        let error = build_v3_responses_provider_response_from_openai_chat_payload(
            &provider_payload,
            &json!({
                "tools": [{"type":"function","function":{"name":"exec_command"}}]
            }),
        )
        .expect_err("stream zero-output upstream diagnostic must not enter stopless");

        assert!(
            error
                .to_string()
                .contains("zero-output upstream diagnostic"),
            "wrong error: {error}"
        );
        assert_eq!(
            observation
                .snapshot()
                .expect("stream observation")
                .finish_reason
                .as_deref(),
            Some("stop")
        );
    }

    #[test]
    fn openai_chat_visible_zero_output_text_with_real_usage_remains_success() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_visible_text",
                "model": "glm-5.2",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "upstream returned zero output tokens is only quoted text here"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 9,
                    "total_tokens": 21
                }
            }),
            &json!({"tools":[]}),
        )
        .expect("visible content with real usage must stay a valid response");

        assert_eq!(response["status"], "completed");
        assert_eq!(
            response["output"][0]["text"],
            "upstream returned zero output tokens is only quoted text here"
        );
    }

    #[test]
    fn openai_chat_upstream_overload_diagnostic_is_provider_error() {
        let manifest = glmrelay_error_policy_manifest();
        let error = build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
            &json!({
                "id": "chatcmpl_overload_diagnostic",
                "model": "glm-5.2",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "mac超负荷运载，应该是挂了"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}
            }),
            &json!({"tools": [{"type":"function","function":{"name":"exec_command"}}]}),
            Some(&manifest),
            Some("glmrelay_openai"),
        )
        .expect_err("upstream overload diagnostic must be provider failure, not success content");

        assert!(
            error.to_string().contains("provider_diagnostic_zero_usage"),
            "wrong error: {error}"
        );
    }

    #[tokio::test]
    async fn openai_chat_stream_overload_diagnostic_policy_is_provider_error() {
        let manifest = glmrelay_error_policy_manifest();
        let observation = V3RuntimeStreamObservation::default();
        let raw_sse = concat!(
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865608,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"reasoning_content\":\"checking\\n\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865638,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{\"content\":\"mac超负荷运载，应该是挂了\",\"role\":\"assistant\"},\"finish_reason\":null,\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865638,\"model\":\"glm-5.2\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}],\"usage\":null}\n\n",
            "data: {\"id\":\"chatcmpl_overload_stream\",\"object\":\"chat.completion.chunk\",\"created\":1784865638,\"model\":\"glm-5.2\",\"choices\":[],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0,\"input_tokens\":0,\"output_tokens\":0}}\n\n",
            "data: [DONE]\n\n",
        );
        let provider = Box::pin(stream::iter(vec![Ok(raw_sse.as_bytes().to_vec())]));
        let provider_payload =
            build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
                provider,
                &observation,
            )
            .await
            .expect("stream diagnostic materializes before semantic policy");

        let error = build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
            &provider_payload,
            &json!({"tools": [{"type":"function","function":{"name":"exec_command"}}]}),
            Some(&manifest),
            Some("glmrelay_openai"),
        )
        .expect_err("configured stream diagnostic must not enter stopless");

        assert!(
            error.to_string().contains("provider_diagnostic_zero_usage"),
            "wrong error: {error}"
        );
    }

    #[test]
    fn openai_chat_overload_text_with_real_usage_remains_success() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_overload_visible_text",
                "model": "glm-5.2",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "mac超负荷运载，应该是挂了"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}
            }),
            &json!({"tools": []}),
        )
        .expect("visible overload-looking content with real usage stays model output");

        assert_eq!(response["status"], "completed");
    }

    #[test]
    fn openai_chat_provider_reasoning_content_projects_before_tool_call() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_reasoning_content",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "reasoning_content": "Need inspect before running the tool.",
                        "tool_calls": [{
                            "id": "call_reasoning_exec",
                            "type": "function",
                            "function": {
                                "name": "exec",
                                "arguments": "{\"input\":\"pwd\"}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            &json!({
                "tools": [{"type":"custom","name":"exec"}]
            }),
        )
        .expect("OpenAI Chat response must project reasoning to Responses");

        assert_eq!(response["status"], "requires_action");
        assert_eq!(response["output"][0]["type"], "reasoning");
        assert_eq!(
            response["output"][0]["summary"][0]["text"], "Need inspect before running the tool.",
            "OpenAI Chat reasoning_content must become replay-safe Responses reasoning.summary before tool calls"
        );
        assert!(
            response["output"][0].get("content").is_none(),
            "private reasoning.content must not leak to client-visible Responses output: {response}"
        );
        assert_eq!(response["output"][1]["type"], "custom_tool_call");
        assert_eq!(response["output"][1]["call_id"], "call_reasoning_exec");
    }

    #[test]
    fn openai_chat_provider_structured_reasoning_keeps_summary_and_encrypted_without_content_leak()
    {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_structured_reasoning",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "visible answer",
                        "reasoning": {
                            "summary": [{"type":"summary_text","text":"safe summary"}],
                            "content": [{"type":"reasoning_text","text":"private chain"}],
                            "encrypted_content": "enc-opaque"
                        }
                    },
                    "finish_reason": "stop"
                }]
            }),
            &json!({"tools":[]}),
        )
        .expect("OpenAI Chat structured reasoning must project to Responses");

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["type"], "reasoning");
        assert_eq!(response["output"][0]["summary"][0]["text"], "safe summary");
        assert_eq!(response["output"][0]["encrypted_content"], "enc-opaque");
        assert!(
            response["output"][0].get("content").is_none(),
            "Responses reasoning item must not expose private reasoning.content: {response}"
        );
        assert_eq!(response["output"][1]["type"], "output_text");
        assert_eq!(response["output"][1]["text"], "visible answer");
        assert!(
            !response.to_string().contains("private chain"),
            "private reasoning.content must not be serialized into the client payload: {response}"
        );
    }

    #[test]
    fn openai_chat_provider_usage_normalizes_to_hub_canonical_token_names() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_usage_shape",
                "choices": [{
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 11,
                    "prompt_tokens_details": {"cached_tokens": 5},
                    "completion_tokens": 7,
                    "completion_tokens_details": {"reasoning_tokens": 2},
                    "total_tokens": 18
                }
            }),
            &json!({"tools":[]}),
        )
        .expect("OpenAI Chat response must project to Responses");

        assert_eq!(response["usage"]["input_tokens"], 11);
        assert_eq!(
            response["usage"]["input_tokens_details"]["cached_tokens"],
            5
        );
        assert_eq!(response["usage"]["output_tokens"], 7);
        assert_eq!(
            response["usage"]["output_tokens_details"]["reasoning_tokens"],
            2
        );
        assert_eq!(response["usage"]["total_tokens"], 18);
        assert!(
            response["usage"].get("prompt_tokens").is_none(),
            "Hub canonical response usage must not expose OpenAI Chat provider-wire prompt_tokens: {response}"
        );
        assert!(
            response["usage"].get("completion_tokens").is_none(),
            "Hub canonical response usage must not expose OpenAI Chat provider-wire completion_tokens: {response}"
        );
    }

    #[test]
    fn openai_chat_custom_tool_arguments_extracts_unescaped_raw_input_wrapper() {
        let raw_input = "python - <<'PY'\nprint(\"hello\")\nPY";
        let arguments = format!("{{\"input\":\"{raw_input}\"}}");

        let input =
            extract_v3_responses_custom_tool_input_from_openai_chat_arguments("exec", &arguments)
                .expect("relaxed custom tool input wrapper");

        assert_eq!(input, raw_input);
    }

    #[test]
    fn openai_chat_custom_tool_arguments_rejects_malformed_non_input_wrapper() {
        let error = extract_v3_responses_custom_tool_input_from_openai_chat_arguments(
            "exec",
            "{\"command\":\"print(\"hello\")\"}",
        )
        .expect_err("malformed non-input wrapper must fail fast");

        assert!(
            error
                .to_string()
                .contains("arguments must be JSON object with string input"),
            "{error}"
        );
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

    #[test]
    fn provider_failure_output_projects_error_chain_body_without_success_wrapping() {
        let output = provider_failure_output(
            V3ResponsesRelayProviderFailure {
                status: 429,
                client_response: json!({
                    "error": {
                        "type": "rate_limit_error",
                        "message": "controlled rate limit"
                    }
                }),
                provider_id: "controlled".to_string(),
                observability: None,
            },
            vec!["V3ProviderReqOutbound09TransportRequest"],
            0,
        );

        assert_eq!(output.status, 429);
        let body = match &output.client_body {
            V3ResponsesRelayClientBody::Json(body) => body,
            V3ResponsesRelayClientBody::Sse(_) => panic!("provider error must project as JSON"),
        };
        assert_eq!(body["error"]["code"], "rate_limit_error");
        assert_eq!(body["error"]["message"], "controlled rate limit");
        assert_eq!(
            body["error"]["stage"],
            "V3ProviderReqOutbound09TransportRequest"
        );
        assert_eq!(body["error"]["class"], "provider_failure");
        assert_eq!(body["error"]["decision"], "project_client_error");
        assert_eq!(body["error"]["target_exhausted"], true);
        assert_eq!(body["error"]["candidates_remaining"], 0);
        assert_eq!(body["error"]["error_node"], "V3Error06ClientProjected");
        assert!(
            body["error"].get("type").is_none(),
            "provider raw error body must not bypass ErrorErr06 projection: {body}"
        );
        assert_eq!(
            output.error_chain.as_deref(),
            Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
        );
        assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
        assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
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
            .contains("provider response event stream ended before response.completed"));
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
    async fn provider_sse_raw_json_error_body_exposes_upstream_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"{\"error\":{\"message\":\"Panic detected\",\"type\":\"new_api_panic\"}}\n\n".to_vec(),
        )]));
        let error = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("new_api_panic"));
        assert!(error.to_string().contains("Panic detected"));
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
        assert!(projected[3].as_ref().unwrap().contains("response.done"));
        assert_eq!(projected[4].as_ref().unwrap(), "data: [DONE]\n\n");
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
        let projected = collect_projected_sse(
            build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(response),
        )
        .await;
        let text = projected
            .iter()
            .map(|chunk| chunk.as_ref().unwrap().as_str())
            .collect::<String>();
        assert!(
            text.contains("event: response.completed"),
            "client SSE requires_action terminal must include response.completed: {text}"
        );
        assert!(
            text.contains("event: response.done"),
            "client SSE requires_action terminal must include response.done before [DONE]: {text}"
        );
        assert!(
            !text.contains("event: response.requires_action"),
            "client SSE must not use the non-terminal requires_action event as stream terminal: {text}"
        );
        assert!(
            text.contains("\"status\":\"requires_action\""),
            "client SSE terminal event must preserve semantic requires_action status: {text}"
        );
        let completed = text
            .find("event: response.completed")
            .expect("response.completed event");
        let done = text
            .find("event: response.done")
            .expect("response.done event");
        let marker = text.find("data: [DONE]").expect("[DONE] marker");
        assert!(
            completed < done && done < marker,
            "Responses client SSE terminal ordering must be response.completed -> response.done -> [DONE]: {text}"
        );
    }

    #[tokio::test]
    async fn anthropic_provider_sse_canonicalizes_responses_response_before_chatprocess() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"MiniMax-M3\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":10}}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"V3_ANTHROPIC_\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"SSE_OK\"}}\n\n".to_vec()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":2}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .expect("Anthropic provider event stream must canonicalize before Responses Chat Process");

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["type"], "message");
        assert_eq!(
            response["output"][0]["content"][0]["text"],
            "V3_ANTHROPIC_SSE_OK"
        );
        let snapshot = observation.snapshot().expect("stream observation");
        assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
        assert_eq!(snapshot.finish_reason.as_deref(), Some("end_turn"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_eof_without_message_stop_fails_before_success() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n".to_vec()),
        ]));
        let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("Anthropic provider event stream ended without message_stop"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_raw_json_error_body_exposes_upstream_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"{\"error\":{\"message\":\"Panic detected\",\"type\":\"new_api_panic\"}}\n\n".to_vec(),
        )]));
        let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("new_api_panic"));
        assert!(error.to_string().contains("Panic detected"));
    }

    #[tokio::test]
    async fn openai_chat_provider_sse_raw_json_error_body_exposes_upstream_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"{\"error\":{\"message\":\"Panic detected\",\"type\":\"new_api_panic\"}}\n\n".to_vec(),
        )]));
        let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::OpenAiChat,
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("new_api_panic"));
        assert!(error.to_string().contains("Panic detected"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_malformed_tool_json_fails_without_text_downgrade() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"MiniMax-M3\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"exec_command\",\"input\":{}}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\":\\\"unterminated\"}}\n\n".to_vec()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
        let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("input_json_delta is malformed"));
    }
}
