use super::*;
use serde_json::{json, Value};
use std::sync::Arc;

pub type V3ResponsesRelayClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub enum V3ResponsesRelayClientBody {
    Json(Value),
    Sse(V3ResponsesRelayClientStream),
}

impl From<String> for V3ResponsesRelayRuntimeError {
    fn from(value: String) -> Self {
        Self::Target(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ResponsesRelayRuntimeInput {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
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
    pub finalized_response: Option<Value>,
    pub provider_snapshots: Option<V3ResponsesRelayProviderSnapshots>,
    pub protocol_direct_handoff: Option<V3ResponsesProtocolDirectHandoff>,
}

#[derive(Debug)]
pub struct V3ResponsesProtocolDirectHandoff {
    pub request_payload: Value,
    pub plan: V3ResponsesProtocolExecutionPlan,
    pub node_trace: Vec<&'static str>,
    pub provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    pub observability_accumulator: V3RuntimeObservabilityAccumulator,
}

pub enum V3ResponsesRelayDryRunOutcome {
    Foundation(crate::V3FoundationRuntimeOutput),
    DirectHandoff(V3ResponsesProtocolDirectHandoff),
}

impl V3ResponsesRelayDryRunOutcome {
    pub(crate) fn into_foundation(self) -> crate::V3FoundationRuntimeOutput {
        match self {
            Self::Foundation(output) => output,
            Self::DirectHandoff(_) => project_v3_debug_failure(
                "V3Execution11ProtocolDecision",
                V3DebugError::MalformedFixture(
                    "Responses Relay provider-request dry run requires its Direct handoff owner"
                        .to_string(),
                ),
            ),
        }
    }
}

pub type V3RuntimeProviderFailureEventSink = Arc<
    dyn Fn(&V3RuntimeObservability, &V3RuntimeProviderFailureObservation) + Send + Sync + 'static,
>;

pub type V3RuntimeRouteSelectionEventSink =
    Arc<dyn Fn(&V3RuntimeObservability) + Send + Sync + 'static>;

pub struct V3ResponsesRelayLocalStoplessControlInput<'a> {
    pub state: &'a V3ResponsesRelayLocalContinuationState,
    pub stopless_control: &'a V3ResponsesRelayStoplessControlState,
    pub scope: V3ResponsesRelayLocalContinuationScope,
    pub now_epoch_ms: u64,
    pub provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    pub route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
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
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    pub fn with_provider_failure_event_sink(
        mut self,
        sink: V3RuntimeProviderFailureEventSink,
    ) -> Self {
        self.provider_failure_event_sink = Some(sink);
        self
    }

    pub fn with_route_selection_event_sink(
        mut self,
        sink: V3RuntimeRouteSelectionEventSink,
    ) -> Self {
        self.route_selection_event_sink = Some(sink);
        self
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
}

impl Default for V3ResponsesRelayRetryPolicy {
    fn default() -> Self {
        Self {
            same_candidate_retries: 0,
        }
    }
}

impl V3ResponsesRelayRetryPolicy {
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        let same_candidate_retries = manifest
            .error
            .provider_error_default_path
            .iter()
            .find_map(|step| match step {
                routecodex_v3_config::V3ProviderDispositionStepManifest::WaitRetry {
                    max_attempts,
                    ..
                } => Some(max_attempts.saturating_sub(1) as usize),
                _ => None,
            })
            .unwrap_or(0);
        Self {
            same_candidate_retries,
        }
    }

    pub(crate) fn as_shared_policy(self) -> V3RelayProviderFailureRetryPolicy {
        V3RelayProviderFailureRetryPolicy {
            same_candidate_retries: self.same_candidate_retries,
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
    pub external_error_kind: Option<String>,
    pub external_error_code: Option<String>,
    pub external_error_status: Option<u16>,
    pub internal_code: Option<String>,
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
    pub timing: Option<V3RuntimeTimingSummary>,
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
    pub timing: Option<V3RuntimeTimingSummary>,
}

pub(crate) struct V3ResponsesRelayProviderFailure {
    pub(crate) status: u16,
    pub(crate) policy_error_type: String,
    pub(crate) policy_error_message: String,
    pub(crate) provider_id: String,
    pub(crate) source_stage: &'static str,
    pub(crate) observability: Option<V3RuntimeObservability>,
    pub(crate) terminal_projection: Option<routecodex_v3_error::V3Error06ClientProjected>,
}

pub(crate) struct V3ResponsesRelayProviderRetryState<'state> {
    pub(crate) failed_candidates: &'state mut BTreeSet<String>,
    pub(crate) same_candidate_retries: &'state mut BTreeMap<String, usize>,
    pub(crate) retry_selected:
        &'state mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pub(crate) pending_recovery: &'state mut Option<V3Error05RecoveryAdmissionWitness>,
    pub(crate) provider_failure_events: &'state mut Vec<V3RuntimeProviderFailureObservation>,
    pub(crate) provider_failure_event_sink: Option<&'state V3RuntimeProviderFailureEventSink>,
    pub(crate) selected_observability: &'state V3RuntimeObservability,
    pub(crate) trace: &'state mut Vec<&'static str>,
}

impl V3RuntimeStreamObservation {
    pub fn snapshot(&self) -> Result<V3RuntimeStreamObservationSnapshot, String> {
        self.inner
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "V3 runtime stream observation state lock is poisoned".to_string())
    }

    pub fn record_provider_event_json(&self, event: &Value) -> Result<(), String> {
        let event_type = event.get("type").and_then(Value::as_str).map(str::trim);
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
            })
            .or_else(|| infer_v3_runtime_response_status_from_provider_event_type(event_type));
        let usage = extract_v3_runtime_usage_summary(semantic)
            .or_else(|| extract_v3_runtime_usage_summary(event));
        let finish_reason = read_v3_runtime_finish_reason(semantic)
            .or_else(|| read_v3_runtime_finish_reason(event))
            .or_else(|| {
                infer_v3_runtime_finish_reason_from_provider_event_json(
                    event_type,
                    response_status.as_deref(),
                )
            })
            .or_else(|| infer_v3_runtime_incomplete_finish_reason(event, event_type));
        // chat/gemini 等非 Responses 客户端 wire 没有 `status` 字段：语义
        // finish_reason 出现即代表该帧已到终态，推导 `completed` 供 console
        // 收口打印 usage（只写 observation 侧信道，绝不进入业务 payload）。
        let response_status = response_status.or_else(|| {
            finish_reason
                .as_deref()
                .filter(|_| event_type.is_none())
                .map(|_| "completed".to_string())
        });
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

    pub(crate) fn record_finish_reason(&self, finish_reason: &str) -> Result<(), String> {
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

    pub(crate) fn record_timing(&self, timing: V3RuntimeTimingSummary) -> Result<(), String> {
        let mut snapshot = self
            .inner
            .lock()
            .map_err(|_| "V3 runtime stream observation state lock is poisoned".to_string())?;
        if snapshot.timing.is_some() {
            return Err("V3 Runtime stream timing is already terminal".to_string());
        }
        snapshot.timing = Some(timing);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesRelayLocalContinuationScope {
    pub(crate) entry_endpoint: String,
    pub(crate) session_id: String,
    pub(crate) conversation_id: String,
    pub(crate) port: u16,
    pub(crate) routing_group: String,
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

    pub(crate) fn local_key(&self) -> V3LocalContinuationScopeKey {
        V3LocalContinuationScopeKey::responses(
            self.entry_endpoint.clone(),
            self.session_id.clone(),
            self.conversation_id.clone(),
            self.port,
            self.routing_group.clone(),
        )
    }

    pub(crate) fn hub_scope(&self, server_id: &str) -> V3HubContinuationScope {
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
    pub fn contains(&self, continuation_id: &str) -> Result<bool, V3ResponsesRelayRuntimeError> {
        Ok(self.lock_store()?.contains(continuation_id))
    }

    pub fn contains_for_req03(
        &self,
        continuation_id: &str,
        scope: &V3ResponsesRelayLocalContinuationScope,
    ) -> Result<bool, V3ResponsesRelayRuntimeError> {
        Ok(self
            .lock_store()?
            .contains_in_scope(&scope.local_key(), continuation_id))
    }

    #[cfg(test)]
    pub(crate) fn commit_for_req03_test(
        &self,
        continuation_id: &str,
        scope: &V3ResponsesRelayLocalContinuationScope,
        now_epoch_ms: u64,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.lock_store()?
            .commit_at_resp04(V3LocalContinuationResp04SaveInput::new(
                continuation_id,
                scope.local_key(),
                json!({"output":[]}),
                V3LocalContinuationTerminalOutcome::NonTerminal,
                now_epoch_ms,
                now_epoch_ms + V3_RESPONSES_RELAY_LOCAL_CONTINUATION_TTL_MS,
            ))
            .map(|_| ())
            .map_err(V3ResponsesRelayRuntimeError::LocalContinuation)
    }

    pub fn len(&self) -> Result<usize, V3ResponsesRelayRuntimeError> {
        Ok(self.lock_store()?.len())
    }

    pub fn is_empty(&self) -> Result<bool, V3ResponsesRelayRuntimeError> {
        Ok(self.lock_store()?.is_empty())
    }

    pub(crate) fn lock_store(
        &self,
    ) -> Result<MutexGuard<'_, V3LocalContinuationStore>, V3ResponsesRelayRuntimeError> {
        self.store
            .lock()
            .map_err(|_| V3ResponsesRelayRuntimeError::LocalContinuationStatePoisoned)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct V3ResponsesRelayStoplessControlScope {
    pub(crate) entry_endpoint: String,
    pub(crate) session_id: String,
    pub(crate) conversation_id: String,
    pub(crate) port: u16,
    pub(crate) routing_group: String,
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

    pub(crate) fn has_client_session_scope(&self) -> bool {
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

#[derive(Debug, Default)]
pub struct V3ResponsesRelayStoplessControlState {
    pub(crate) center: V3ServerToolCenter,
}

impl V3ResponsesRelayStoplessControlState {
    pub(crate) fn center_key(
        scope: &V3ResponsesRelayStoplessControlScope,
    ) -> V3ServerToolCenterKey {
        V3ServerToolCenterKey {
            tool_name: V3ServerToolName::Stopless,
            scope_key: format!(
                "{}|{}|{}|{}|{}",
                scope.entry_endpoint,
                scope.port,
                scope.routing_group,
                scope.session_id,
                scope.conversation_id
            ),
        }
    }

    pub fn len(&self) -> Result<usize, V3ResponsesRelayRuntimeError> {
        self.center
            .len()
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }

    pub fn is_empty(&self) -> Result<bool, V3ResponsesRelayRuntimeError> {
        self.center
            .is_empty()
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }

    pub fn load_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
    ) -> Result<Option<V3StoplessCenterState>, V3ResponsesRelayRuntimeError> {
        match self
            .center
            .load(&Self::center_key(scope))
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)?
        {
            Some(V3ServerToolInstanceState::Stopless(state)) => Ok(Some(state)),
            Some(_) => Err(V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned),
            None => Ok(None),
        }
    }

    pub fn store_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
        state: V3StoplessCenterState,
        written_by: V3ServerToolCenterWriteOrigin,
        reason: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .store(
                Self::center_key(scope),
                V3ServerToolInstanceState::Stopless(state),
                written_by,
                reason,
                request_id,
            )
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }

    pub fn clear_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
        written_by: V3ServerToolCenterWriteOrigin,
        reason: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .clear(&Self::center_key(scope), written_by, reason, request_id)
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }
}

#[derive(Clone)]
pub(crate) struct V3LiveSnapResponsesTransport<T> {
    pub(crate) inner: T,
    pub(crate) snapshots: V3LiveSnapProviderSnapshotRecorder,
}

impl V3LiveSnapResponsesTransport<ReqwestResponsesTransport> {
    pub(crate) fn with_default_transport() -> Self {
        Self {
            inner: ReqwestResponsesTransport::default(),
            snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
        }
    }
}

impl<T> V3LiveSnapResponsesTransport<T> {
    pub(crate) fn snapshots(&self) -> V3LiveSnapProviderSnapshotRecorder {
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
pub(crate) struct V3LiveSnapProviderSnapshotRecorder {
    pub(crate) inner: Arc<Mutex<V3LiveSnapProviderSnapshotState>>,
}

#[derive(Default)]
pub(crate) struct V3LiveSnapProviderSnapshotState {
    pub(crate) requests: Vec<Value>,
    pub(crate) responses: Vec<Value>,
}

impl V3LiveSnapProviderSnapshotRecorder {
    pub(crate) fn record_provider_request(
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
            "request": request.provider_request_projection(),
        }));
        Ok(attempt)
    }

    pub(crate) fn record_provider_response(
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

    pub(crate) fn record_provider_error(
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
            V3ProviderError::ProviderModelBindingMismatch {
                request_id,
                provider_id,
                ..
            } => self.record_transport_provider_error(attempt, request_id, provider_id, error),
            V3ProviderError::InvalidWireBody { request_id }
            | V3ProviderError::InvalidStreamIntent { request_id }
            | V3ProviderError::InvalidDataImage { request_id, .. }
            | V3ProviderError::ControlFieldInWireBody { request_id, .. }
            | V3ProviderError::NamespaceToolFlattenFailed { request_id, .. }
            | V3ProviderError::FunctionToolShapeFailed { request_id, .. } => {
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

    pub(crate) fn record_json_provider_response(
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

    pub(crate) fn record_sse_provider_response_start(
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

    pub(crate) fn append_sse_provider_response_chunk(
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

    pub(crate) fn record_sse_provider_response_error(
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

    pub(crate) fn record_transport_provider_error(
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

    pub(crate) fn provider_request_payload(&self) -> Option<Value> {
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

    pub(crate) fn provider_response_payload(&self) -> Option<Value> {
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

    pub(crate) fn into_payload(
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
    pub(crate) fn provider_response_payload_for_selector(&self, selector: &str) -> Option<Value> {
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
            .field(
                "finalized_response",
                &self.finalized_response.as_ref().map(|_| "present"),
            )
            .field("protocol_direct_handoff", &self.protocol_direct_handoff)
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
    #[error("V3 Responses Relay requested direct provider model not found: {0}")]
    ModelNotFound(String),
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
    #[error("web_search Mode B requires exactly one backend binding at runtime: {0}")]
    WebSearchBackendBindingMissing(String),
    #[error("web_search local search hop failed: {0}")]
    WebSearchDispatchFailed(String),
    #[error("web_search local search hop returned no usable result: {0}")]
    WebSearchResultUnavailable(String),
    #[error("V3 Responses Relay provider SSE transport failed: {0}")]
    ProviderSseTransport(String),
    #[error("V3 Responses Relay provider response event codec failed: {0}")]
    ProviderResponseEventCodec(String),
    #[error("V3 Responses Relay Runtime timing failed: {0}")]
    RuntimeTiming(String),
    #[error("V3 Responses Relay provider semantic failure {code} status {status}: {message}")]
    ProviderResponseSemanticFailure {
        status: u16,
        code: String,
        message: String,
    },
    #[error(transparent)]
    LocalContinuation(#[from] V3LocalContinuationError),
    #[error("V3 Responses Relay local continuation scope routing group does not match server")]
    LocalContinuationScopeMismatch,
    #[error("V3 Responses Relay local continuation state lock is poisoned")]
    LocalContinuationStatePoisoned,
    #[error("V3 Responses Relay stopless runtime_control state lock is poisoned")]
    StoplessControlStatePoisoned,
}
