use super::web_search_hop::{
    apply_v3_responses_relay_web_search_control_completion, execute_local_web_search_hop,
    project_web_search_result_into_finalized, resolve_request_web_search_backend_binding,
    resolve_web_search_mode_and_backend,
};
use super::*;
#[cfg(test)]
use crate::local_continuation::{
    V3LocalContinuationResp04SaveInput, V3LocalContinuationTerminalOutcome,
};
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    expand_v3_relay_target_plan_for_selected, project_v3_client_disconnect,
    provider_runtime_failure_stage, resolve_v3_relay_target_outcome,
    run_v3_relay_provider_failure_policy, v3_relay_provider_candidate_key_parts,
    v3_relay_provider_policy_now_epoch_ms, v3_relay_provider_target_selection_sample,
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyEvent, V3RelayProviderFailurePolicyState,
    V3RelayProviderFailureRetryPolicy, V3RelayProviderTargetResolution,
    V3RelayProviderTargetResolutionInput, V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET,
};
use crate::runtime_timing::{V3RuntimeObservabilityAccumulator, V3RuntimeTimingSummary};
use crate::{
    build_v3_execution_11_protocol_decision_from_v3_target_10, project_v3_debug_failure,
    V3Execution11ProtocolDecisionMode, V3ResponsesProtocolExecutionPlan,
};
use futures_util::StreamExt;
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ProviderErrorActionPolicyManifest,
    V3ProviderErrorMatcherManifest,
};
use routecodex_v3_debug::V3DebugError;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ProviderFailureSessionScope, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload, ReqwestResponsesTransport, ResponsesTransport,
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError, V3ProviderHealthStore,
    V3ProviderResp14Raw, V3ProviderResponseBody, V3ProviderResponseHeader,
    V3ResponsesProviderTarget, V3ResponsesStreamIntent, V3Transport13ResponsesHttpRequest,
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
const V3_ANTHROPIC_CYBER_REFUSAL_CODE: &str = "ANTHROPIC_CYBER_REFUSAL";
const V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_COUNT: usize =
    V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET;
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
    fn into_foundation(self) -> crate::V3FoundationRuntimeOutput {
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
            same_candidate_retries: V3_RESPONSES_RELAY_PROVIDER_FAILURE_RETRY_COUNT,
        }
    }
}

impl V3ResponsesRelayRetryPolicy {
    fn as_shared_policy(self) -> V3RelayProviderFailureRetryPolicy {
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

struct V3ResponsesRelayProviderFailure {
    status: u16,
    policy_error_type: String,
    policy_error_message: String,
    provider_id: String,
    source_stage: &'static str,
    observability: Option<V3RuntimeObservability>,
    terminal_projection: Option<routecodex_v3_error::V3Error06ClientProjected>,
}

#[derive(Debug, Clone)]
pub struct V3ResponsesRelayProviderHealthHandle {
    runtime_health: V3ProviderFailureRuntimeHealth,
}

impl V3ResponsesRelayProviderHealthHandle {
    pub fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            runtime_health: V3ProviderFailureRuntimeHealth::from_manifest(manifest),
        }
    }

    pub fn store(&self) -> V3ProviderHealthStore {
        self.runtime_health.store()
    }

    pub fn runtime_health(&self) -> V3ProviderFailureRuntimeHealth {
        self.runtime_health.clone()
    }
}

struct V3ResponsesRelayProviderRetryState<'state> {
    failed_candidates: &'state mut BTreeSet<String>,
    same_candidate_retries: &'state mut BTreeMap<String, usize>,
    retry_selected: &'state mut Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    pending_recovery: &'state mut Option<V3Error05RecoveryAdmissionWitness>,
    provider_failure_events: &'state mut Vec<V3RuntimeProviderFailureObservation>,
    provider_failure_event_sink: Option<&'state V3RuntimeProviderFailureEventSink>,
    selected_observability: &'state V3RuntimeObservability,
    trace: &'state mut Vec<&'static str>,
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
    fn center_key(scope: &V3ResponsesRelayStoplessControlScope) -> V3ServerToolCenterKey {
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
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .store(
                Self::center_key(scope),
                V3ServerToolInstanceState::Stopless(state),
            )
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }

    pub fn clear_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .clear(&Self::center_key(scope))
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

pub async fn execute_v3_responses_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime(manifest, input, &ReqwestResponsesTransport::default()).await
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
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::default(),
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
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
    let provider_failure_event_sink = local_stopless.provider_failure_event_sink.clone();
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
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::default(),
        provider_failure_event_sink,
        local_stopless.route_selection_event_sink.clone(),
        None,
        None,
        BTreeSet::new(),
        None,
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_transport_health_local_continuation_stopless_control_and_initial_target<
    T: ResponsesTransport,
>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    local_stopless: V3ResponsesRelayLocalStoplessControlInput<'_>,
    initial_selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    initial_expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: BTreeSet<String>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&local_stopless.scope);
    let provider_failure_event_sink = local_stopless.provider_failure_event_sink.clone();
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
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::default(),
        provider_failure_event_sink,
        local_stopless.route_selection_event_sink.clone(),
        Some(initial_selected_target),
        Some(initial_expanded),
        request_local_excluded_candidates,
        observability_accumulator,
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

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_and_initial_target(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    initial_selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    initial_expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_transport_health_local_continuation_stopless_control_and_initial_target(
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
        initial_selected_target,
        initial_expanded,
        BTreeSet::new(),
        None,
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    local_stopless: V3ResponsesRelayLocalStoplessControlInput<'_>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
        local_stopless,
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    local_stopless: V3ResponsesRelayLocalStoplessControlInput<'_>,
    initial_selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    initial_expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: BTreeSet<String>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_transport_health_local_continuation_stopless_control_and_initial_target(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
        local_stopless,
        initial_selected_target,
        initial_expanded,
        request_local_excluded_candidates,
        observability_accumulator,
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

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_provider_snapshots_and_initial_target(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    local_stopless: V3ResponsesRelayLocalStoplessControlInput<'_>,
    capture: V3ResponsesRelayProviderSnapshotCapture,
    initial_selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    initial_expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: BTreeSet<String>,
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let transport = V3LiveSnapResponsesTransport::with_default_transport();
    let snapshots = transport.snapshots();
    let mut output =
        execute_v3_responses_relay_runtime_with_transport_health_local_continuation_stopless_control_and_initial_target(
            manifest,
            input,
            &transport,
            provider_health,
            local_stopless,
            initial_selected_target,
            initial_expanded,
            request_local_excluded_candidates,
            observability_accumulator,
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
        provider_health.runtime_health(),
        retry_policy,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
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
        provider_health.runtime_health(),
        retry_policy,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
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
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&scope);
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
        Some(V3ResponsesRelayStoplessControlExecution {
            control: &stopless_control,
            scope: stopless_scope,
            commit_effects: true,
        }),
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::default(),
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
    )
    .await
}

struct V3ResponsesRelayLocalContinuationExecution<'state> {
    state: &'state V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    commit_resp04_effects: bool,
}

pub(crate) struct V3ResponsesRelayStoplessControlExecution<'state> {
    pub(crate) control: &'state V3ResponsesRelayStoplessControlState,
    pub(crate) scope: V3ResponsesRelayStoplessControlScope,
    pub(crate) commit_effects: bool,
}

async fn execute_v3_responses_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    stopless_control: Option<V3ResponsesRelayStoplessControlExecution<'_>>,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3ResponsesRelayRetryPolicy,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    initial_request_local_excluded_candidates: BTreeSet<String>,
    initial_observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let observability_accumulator =
        initial_observability_accumulator.unwrap_or_else(V3RuntimeObservabilityAccumulator::start);
    let runtime_timing = observability_accumulator.timing();
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
        .unwrap_or(false);
    let mut trace = Vec::with_capacity(17);
    let client_response_transport_intent =
        v3_responses_relay_transport_intent_from_stream_field(&input.payload);
    let provider_request_transport_intent = client_response_transport_intent;
    let local_tool_output_ids = find_responses_tool_output_ids(&input.payload)?;
    let protocol_switch_allowed =
        responses_relay_protocol_switch_allowed(&input.payload, &local_tool_output_ids);
    apply_v3_responses_relay_web_search_control_completion(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
        &input.payload,
    )?;
    let request_web_search_execution_mode =
        resolve_request_web_search_execution_mode(manifest, &input.payload);
    let request_web_search_backend_binding =
        resolve_request_web_search_backend_binding(manifest, &input.payload);
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        input.payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        client_response_transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    let req02 = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(req01)
        .map_err(V3ResponsesRelayRuntimeError::InboundCanonical)?;
    trace.push("V3HubReqInbound02Normalized");
    let route_facts_body = req02.payload().clone();
    let base_hub_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        &input.server_id,
        server_routing_group(manifest, &input.server_id)?,
        &input.request_id,
    );
    let request_stopless_control_state = load_v3_responses_relay_stopless_control_state(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
    )?;
    let request_hook_profile = responses_relay_request_hook_profile(
        manifest,
        &input.server_id,
        request_stopless_control_state.as_ref(),
        stopless_control_has_client_session_scope,
        &transition_request_id,
        transition_updated_at,
        request_web_search_execution_mode,
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
    let stopless_state = request_outcome
        .stopless_state()
        .cloned()
        .map(|state| state.with_max_stop_budget_floor(4));
    apply_v3_responses_relay_stopless_control_request_transition(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
        request_stopless_control_state.is_some(),
        stopless_state.as_ref(),
    )?;
    let request_web_search_state = request_outcome.web_search_state().cloned();
    apply_v3_responses_relay_web_search_control_request_transition(
        manifest,
        &input.server_id,
        stopless_control.as_ref(),
        request_web_search_state.as_ref(),
    )?;
    macro_rules! handle_error_before_resp03 {
        ($expr:expr) => {
            match $expr {
                Ok(value) => value,
                Err(error) => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(error.into());
                }
            }
        };
    }
    let provider_semantic_body = std::sync::Arc::clone(request_outcome.payload_arc());
    let anthropic_response_projection_context =
        V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&provider_semantic_body)
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderWireEncoding(error.to_string())
            })?;
    let req04 = request_outcome.into_governed();
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    trace.push("V3HubReqExecution05Planned");
    let mut failed_candidates = initial_request_local_excluded_candidates;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut pending_provider_action_recovery = None;
    let mut initial_selected_target = initial_selected_target;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut provider_send_attempts = 0usize;
    let deterministic_sample = v3_relay_provider_target_selection_sample(&input.request_id);
    let shared_retry_policy = retry_policy.as_shared_policy();
    let provider_failure_health = provider_health.clone();
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        captured_target_09: initial_expanded.as_ref(),
        failure_session_scope: input.failure_session_scope.clone(),
        provider_health: &provider_failure_health,
        retry_policy: shared_retry_policy,
        deterministic_sample,
    };
    let allowed_modes = allowed_execution_modes_for_relay_server(manifest, &input.server_id)?;
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else if let Some(selected) = initial_selected_target.take() {
            selected
        } else {
            match resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
                manifest,
                server_id: &input.server_id,
                failure_session_scope: &input.failure_session_scope,
                entry_kind: "responses",
                endpoint_path: "/v1/responses",
                body: &route_facts_body,
                request_local_excluded_candidates: &failed_candidates,
                provider_health: &provider_health,
                now_ms: v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                deterministic_sample,
            }) {
                V3RelayProviderTargetResolution::Selected(selected) => selected,
                V3RelayProviderTargetResolution::Failed(source)
                    if source.source_kind == V3ErrorSourceKind::ModelNotFound =>
                {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::ModelNotFound(
                        source.message.clone(),
                    ));
                }
                V3RelayProviderTargetResolution::Failed(source) => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )));
                }
                V3RelayProviderTargetResolution::Exhausted {
                    attempted_candidates,
                } => {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Err(V3ResponsesRelayRuntimeError::Target(format!(
                        "selected target exhausted after {attempted_candidates:?}"
                    )));
                }
            }
        };
        if protocol_switch_allowed {
            let decision = build_v3_execution_11_protocol_decision_from_v3_target_10(
                selected.clone(),
                "responses",
                &allowed_modes,
            )
            .map_err(|source| V3ResponsesRelayRuntimeError::Target(source.message.clone()))?;
            if decision.mode == V3Execution11ProtocolDecisionMode::SameProtocolDirect {
                trace.push("V3Execution11ProtocolDecision");
                let expanded = match initial_expanded.clone() {
                    Some(expanded) => expanded,
                    None => expand_v3_relay_target_plan_for_selected(
                        manifest,
                        &selected,
                        deterministic_sample,
                    )
                    .map_err(V3ResponsesRelayRuntimeError::Target)?,
                };
                clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                    manifest,
                    &input.server_id,
                    stopless_control.as_ref(),
                    stopless_state.as_ref(),
                )?;
                return Ok(V3ResponsesRelayRuntimeOutput {
                    status: 0,
                    client_body: V3ResponsesRelayClientBody::Json(Value::Null),
                    node_trace: Vec::new(),
                    error_chain: None,
                    observability: None,
                    stream_observation: None,
                    finalized_response: None,
                    provider_snapshots: None,
                    protocol_direct_handoff: Some(V3ResponsesProtocolDirectHandoff {
                        request_payload:
                            build_v3_openai_responses_standard_request_from_chat_canonical(
                                &provider_semantic_body,
                            )
                            .map_err(V3ResponsesRelayRuntimeError::ProviderWireEncoding)?,
                        plan: V3ResponsesProtocolExecutionPlan {
                            decision,
                            node_trace: vec![
                                "V3Req04StandardizedResponses",
                                "V3Router05RequestClassified",
                                "V3Router06RoutePoolResolved",
                                "V3Router07OpaqueTargetHitOnce",
                                "V3Target08KindClassified",
                                "V3Target09CandidateSetExpanded",
                                "V3Target10ConcreteProviderSelected",
                                "V3Execution11ProtocolDecision",
                            ],
                            expanded,
                            protocol_candidate_keys: BTreeSet::new(),
                            request_local_excluded_candidates: failed_candidates.clone(),
                        },
                        node_trace: trace,
                        provider_failure_events: provider_failure_events.clone(),
                        observability_accumulator: observability_accumulator
                            .clone()
                            .with_additional_attempts(provider_send_attempts),
                    }),
                });
            }
        }
        let selected_target_provider_id = selected.candidate.provider_id.clone();
        let selected_target_auth_alias = selected.candidate.auth_alias.clone();
        let selected_target_model_id = selected.candidate.model_id.clone();
        let provider_wire_protocol = handle_error_before_resp03!(
            provider_wire_protocol_for_selected_candidate(&selected.candidate)
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
        let target =
            handle_error_before_resp03!(provider_target(manifest, req07.selected_target()));
        let mut selected_observability =
            build_v3_relay_observability_from_selected(&selected, client_response_transport_intent);
        selected_observability.attempts = Some(
            observability_accumulator
                .attempts()
                .saturating_add(provider_send_attempts)
                .saturating_add(1),
        );
        selected_observability.provider_failure_events = provider_failure_events.clone();
        if let Some(sink) = route_selection_event_sink.as_ref() {
            sink(&selected_observability);
        }
        macro_rules! handle_provider_request_failure {
            ($error:expr) => {{
                let failure = provider_request_relay_failure(
                    $error,
                    &selected_target_provider_id,
                    Some(selected_observability.clone()),
                )?;
                let terminal_failure = handle_error_before_resp03!(
                    handle_v3_responses_relay_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3ResponsesRelayProviderRetryState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            retry_selected: &mut retry_selected,
                            pending_recovery: &mut pending_provider_action_recovery,
                            provider_failure_events: &mut provider_failure_events,
                            provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                            selected_observability: &selected_observability,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }};
        }
        let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {
            Ok(req_compat) => req_compat,
            Err(error) => {
                handle_provider_request_failure!(V3ResponsesRelayRuntimeError::ProviderCompat(
                    error
                ));
            }
        };
        provider_send_attempts = provider_send_attempts.saturating_add(1);
        trace.push("V3HubReqTarget06Resolved");
        trace.push("V3HubReqOutbound07ProviderSemantic");
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = _req09.into_provider_semantic_payload();
        let wire = match build_v3_provider_12_responses_wire_payload(
            &input.request_id,
            target,
            provider_semantic,
        ) {
            Ok(wire) => wire,
            Err(error) => {
                handle_provider_request_failure!(V3ResponsesRelayRuntimeError::Provider(error));
            }
        };
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request =
            match build_v3_provider_transport_request_for_protocol(provider_wire_protocol, wire) {
                Ok(transport_request) => transport_request,
                Err(error) => {
                    handle_provider_request_failure!(V3ResponsesRelayRuntimeError::Target(error));
                }
            };
        if let Err(error) = validate_v3_responses_relay_provider_request_transport_intent(
            provider_request_transport_intent,
            transport_request.stream_intent(),
        ) {
            handle_provider_request_failure!(error);
        }
        trace.push("V3ProviderReqOutbound09TransportRequest");
        let mut _provider_action_permit: Option<V3ProviderActionPermit> = None;
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match handle_error_before_resp03!(provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
                .map_err(V3ResponsesRelayRuntimeError::ProviderHealth))
            {
                V3ProviderActionRecoveryTransition::Admitted(mut admission) => {
                    _provider_action_permit = admission.take_permit();
                    trace.push("V3ProviderActionGateAdmission");
                }
                V3ProviderActionRecoveryTransition::Superseded(ticket) => {
                    pending_provider_action_recovery = Some(handle_error_before_resp03!(ticket
                        .recovery_witness()
                        .map_err(V3ResponsesRelayRuntimeError::ProviderHealth)));
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket) => {
                    pending_provider_action_recovery = Some(handle_error_before_resp03!(ticket
                        .recovery_witness()
                        .map_err(V3ResponsesRelayRuntimeError::ProviderHealth)));
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
            }
        }
        handle_error_before_resp03!(runtime_timing
            .start_external()
            .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                handle_error_before_resp03!(runtime_timing
                    .finish_external()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                let failure = provider_http_failure(
                    response.status,
                    &response.body,
                    &selected_target_provider_id,
                    Some(selected_observability.clone()),
                );
                drop(_provider_action_permit.take());
                let terminal_failure = handle_error_before_resp03!(
                    handle_v3_responses_relay_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3ResponsesRelayProviderRetryState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            retry_selected: &mut retry_selected,
                            pending_recovery: &mut pending_provider_action_recovery,
                            provider_failure_events: &mut provider_failure_events,
                            provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                            selected_observability: &selected_observability,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
            Err(error) => {
                handle_error_before_resp03!(runtime_timing
                    .finish_external()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                let failure = provider_runtime_failure(
                    error,
                    &selected_target_provider_id,
                    Some(selected_observability.clone()),
                );
                drop(_provider_action_permit.take());
                let terminal_failure = handle_error_before_resp03!(
                    handle_v3_responses_relay_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3ResponsesRelayProviderRetryState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            retry_selected: &mut retry_selected,
                            pending_recovery: &mut pending_provider_action_recovery,
                            provider_failure_events: &mut provider_failure_events,
                            provider_failure_event_sink: provider_failure_event_sink.as_ref(),
                            selected_observability: &selected_observability,
                            trace: &mut trace,
                        },
                    )
                    .await
                );
                if let Some(failure) = terminal_failure {
                    clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                        manifest,
                        &input.server_id,
                        stopless_control.as_ref(),
                        stopless_state.as_ref(),
                    )?;
                    return Ok(provider_failure_output(failure, trace, 0));
                }
                continue;
            }
        };
        if provider_raw.body_kind()
            == routecodex_v3_provider_responses::V3ProviderResponseBodyKind::Json
        {
            handle_error_before_resp03!(runtime_timing
                .finish_external()
                .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
        }
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
                            Some(selected_observability.clone()),
                        );
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                };
                if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                    if let Some(semantic_error) =
                        anthropic_cyber_refusal_error_from_payload(&provider_value)
                    {
                        let failure = provider_semantic_failure(
                            429,
                            semantic_error,
                            &selected_target_provider_id,
                            Some(selected_observability.clone()),
                        );
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let hook_provider_value =
                    if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
                        handle_error_before_resp03!(
                            project_v3_anthropic_message_as_responses_response_with_context(
                                &provider_value,
                                &anthropic_response_projection_context,
                            )
                            .map_err(|error| {
                                V3ResponsesRelayRuntimeError::InboundCanonical(error.to_string())
                            })
                        )
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
                            Some(selected_observability.clone()),
                        );
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let (
                    action,
                    mut finalized_provider_value,
                    response_stopless_state,
                    response_web_search_state,
                ) = match run_json_response_hooks(
                    V3ResponsesRelayJsonResponseHookInput {
                        provider_value: &hook_provider_value,
                        provider_semantic_body: &provider_semantic_body,
                        manifest,
                        server_id: &input.server_id,
                        provider_id: Some(&selected_target_provider_id),
                        provider_protocol: hook_provider_protocol,
                        provider_response_transport_intent: V3HubTransportIntent::Json,
                        compatibility_profile: selected.candidate.compatibility_profile.as_deref(),
                        web_search_execution_mode: selected.candidate.web_search_execution_mode,
                        web_search_center_state: request_web_search_state.clone().or_else(|| {
                            stopless_control
                                .as_ref()
                                .and_then(|execution| {
                                    execution
                                        .control
                                        .web_search_load_for_scope(&execution.scope)
                                        .ok()
                                })
                                .flatten()
                        }),
                        stopless_state: stopless_state.as_ref(),
                        stopless_control_has_client_session_scope,
                        transition_request_id: &transition_request_id,
                        transition_updated_at,
                    },
                    &mut trace,
                ) {
                    Ok(value) => value,
                    Err(error) if is_v3_responses_provider_response_failure(&error) => {
                        let failure = provider_response_hook_failure(
                            error,
                            &selected_target_provider_id,
                            Some(selected_observability.clone()),
                        );
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                    Err(error) => handle_error_before_resp03!(Err(error)),
                };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    &input.server_id,
                    stopless_control.as_ref(),
                    response_stopless_state.clone(),
                )?;
                if let Some(web_search_state) = response_web_search_state {
                    let captured = if web_search_state.phase()
                        == V3WebSearchCenterPhase::SearchResultCaptured
                    {
                        web_search_state
                    } else {
                        execute_local_web_search_hop(
                            manifest,
                            &input.server_id,
                            &input.failure_session_scope,
                            &provider_failure_health,
                            request_web_search_backend_binding.as_deref(),
                            &web_search_state,
                            transport,
                            &input.request_id,
                        )
                        .await?
                    };
                    project_web_search_result_into_finalized(
                        &mut finalized_provider_value,
                        &captured,
                    )?;
                    if let Some(execution) = stopless_control.as_ref() {
                        if execution.commit_effects && execution.scope.has_client_session_scope() {
                            execution
                                .control
                                .web_search_store_for_scope(&execution.scope, captured)?;
                        }
                    }
                }
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    provider_semantic_body.as_ref(),
                    &finalized_provider_value,
                    action,
                )?;
                handle_error_before_resp03!(provider_health
                    .record_provider_success_in_failure_scope(
                        &failure_context.failure_session_scope,
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
                observability.stopless_activation = response_stopless_state
                    .as_ref()
                    .and_then(V3StoplessCenterState::last_provider_stopless_call_id)
                    .is_some();
                observability.timing = Some(handle_error_before_resp03!(runtime_timing
                    .finish_runtime()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming)));
                let finalized_response = finalized_provider_value.clone();
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
                    finalized_response: Some(finalized_response),
                    provider_snapshots: None,
                    protocol_direct_handoff: None,
                });
            }
            V3ProviderResponseBody::Sse(stream) => {
                let stream_observation = V3RuntimeStreamObservation::default();
                let provider_value_result =
                    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
                        provider_wire_protocol,
                        stream,
                        &stream_observation,
                        &anthropic_response_projection_context,
                    )
                    .await;
                handle_error_before_resp03!(runtime_timing
                    .finish_external()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                let provider_value = match provider_value_result {
                    Ok(value) => value,
                    Err(error) => {
                        let failure = provider_response_stream_relay_failure(
                            error,
                            &input.request_id,
                            &selected_target_provider_id,
                            Some(selected_observability.clone()),
                        );
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
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
                            Some(selected_observability.clone()),
                        );
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                }
                let (
                    action,
                    mut finalized_provider_value,
                    response_stopless_state,
                    response_web_search_state,
                ) = match run_json_response_hooks(
                    V3ResponsesRelayJsonResponseHookInput {
                        provider_value: &provider_value,
                        provider_semantic_body: &provider_semantic_body,
                        manifest,
                        server_id: &input.server_id,
                        provider_id: Some(&selected_target_provider_id),
                        provider_protocol: hook_provider_protocol,
                        provider_response_transport_intent: V3HubTransportIntent::Sse,
                        compatibility_profile: selected.candidate.compatibility_profile.as_deref(),
                        web_search_execution_mode: selected.candidate.web_search_execution_mode,
                        // web_search 与 stopless 解耦：当前轮拦截直接使用 Req04
                        // 激活的 LocalToolSurfaceActive state（request_web_search_state），
                        // 不依赖 stopless_control 桶。
                        web_search_center_state: request_web_search_state.clone().or_else(|| {
                            stopless_control
                                .as_ref()
                                .and_then(|execution| {
                                    execution
                                        .control
                                        .web_search_load_for_scope(&execution.scope)
                                        .ok()
                                })
                                .flatten()
                        }),
                        stopless_state: stopless_state.as_ref(),
                        stopless_control_has_client_session_scope,
                        transition_request_id: &transition_request_id,
                        transition_updated_at,
                    },
                    &mut trace,
                ) {
                    Ok(value) => value,
                    Err(error) if is_v3_responses_provider_response_failure(&error) => {
                        let failure = provider_response_hook_failure(
                            error,
                            &selected_target_provider_id,
                            Some(selected_observability.clone()),
                        );
                        drop(_provider_action_permit.take());
                        let terminal_failure = handle_error_before_resp03!(
                            handle_v3_responses_relay_provider_failure(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3ResponsesRelayProviderRetryState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    retry_selected: &mut retry_selected,
                                    pending_recovery: &mut pending_provider_action_recovery,
                                    provider_failure_events: &mut provider_failure_events,
                                    provider_failure_event_sink: provider_failure_event_sink
                                        .as_ref(),
                                    selected_observability: &selected_observability,
                                    trace: &mut trace,
                                },
                            )
                            .await
                        );
                        if let Some(failure) = terminal_failure {
                            clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
                                manifest,
                                &input.server_id,
                                stopless_control.as_ref(),
                                stopless_state.as_ref(),
                            )?;
                            return Ok(provider_failure_output(failure, trace, 0));
                        }
                        continue;
                    }
                    Err(error) => handle_error_before_resp03!(Err(error)),
                };
                apply_v3_responses_relay_stopless_control_transition(
                    manifest,
                    &input.server_id,
                    stopless_control.as_ref(),
                    response_stopless_state.clone(),
                )?;
                if let Some(web_search_state) = response_web_search_state {
                    // MiniMax hosted search：结果已随同一响应返回
                    // （SearchResultCaptured）→ 跳过本地搜索 hop；否则走
                    // backend direct pin 的搜索 hop。
                    let captured = if web_search_state.phase()
                        == V3WebSearchCenterPhase::SearchResultCaptured
                    {
                        web_search_state
                    } else {
                        execute_local_web_search_hop(
                            manifest,
                            &input.server_id,
                            &input.failure_session_scope,
                            &provider_failure_health,
                            request_web_search_backend_binding.as_deref(),
                            &web_search_state,
                            transport,
                            &input.request_id,
                        )
                        .await?
                    };
                    project_web_search_result_into_finalized(
                        &mut finalized_provider_value,
                        &captured,
                    )?;
                    if let Some(execution) = stopless_control.as_ref() {
                        if execution.commit_effects && execution.scope.has_client_session_scope() {
                            execution
                                .control
                                .web_search_store_for_scope(&execution.scope, captured)?;
                        }
                    }
                }
                commit_or_release_responses_local_continuation(
                    local.as_ref(),
                    &local_tool_output_ids.consumed_ids,
                    provider_semantic_body.as_ref(),
                    &finalized_provider_value,
                    action,
                )?;
                handle_error_before_resp03!(provider_health
                    .record_provider_success_in_failure_scope(
                        &failure_context.failure_session_scope,
                        &selected_target_provider_id,
                        Some(&selected_target_auth_alias),
                        Some(&selected_target_model_id),
                        v3_responses_relay_now_epoch_ms()?,
                    )
                    .map_err(|error| V3ResponsesRelayRuntimeError::ProviderHealth(
                        error.to_string()
                    )));
                stream_observation
                    .record_provider_event_json(&json!({
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
                observability.stopless_activation = response_stopless_state
                    .as_ref()
                    .and_then(V3StoplessCenterState::last_provider_stopless_call_id)
                    .is_some();
                let timing = handle_error_before_resp03!(runtime_timing
                    .finish_runtime()
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming));
                observability.timing = Some(timing);
                stream_observation
                    .record_timing(timing)
                    .map_err(V3ResponsesRelayRuntimeError::RuntimeTiming)?;
                let client_response_is_sse =
                    client_response_transport_intent == V3HubTransportIntent::Sse;
                let finalized_response = finalized_provider_value.clone();
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
                    finalized_response: Some(finalized_response),
                    provider_snapshots: None,
                    protocol_direct_handoff: None,
                });
            }
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct V3ResponsesRelayToolOutputIds {
    restore_ids: Vec<String>,
    pub(crate) consumed_ids: Vec<String>,
}

pub(crate) fn find_responses_tool_output_ids(
    payload: &Value,
) -> Result<V3ResponsesRelayToolOutputIds, V3ResponsesRelayRuntimeError> {
    let paired_call_ids = payload_input_paired_call_ids(payload);
    let previous_response_id = payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let mut ids = V3ResponsesRelayToolOutputIds::default();
    if let Some(previous_response_id) = previous_response_id {
        ids.consumed_ids.push(previous_response_id.to_owned());
    }
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

fn responses_relay_protocol_switch_allowed(
    payload: &Value,
    tool_output_ids: &V3ResponsesRelayToolOutputIds,
) -> bool {
    payload
        .get("previous_response_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .is_none()
        && tool_output_ids.restore_ids.is_empty()
}

async fn handle_v3_responses_relay_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    mut failure: V3ResponsesRelayProviderFailure,
    state: &mut V3ResponsesRelayProviderRetryState<'_>,
) -> Result<Option<V3ResponsesRelayProviderFailure>, V3ResponsesRelayRuntimeError> {
    if failure.terminal_projection.is_some() {
        return Ok(Some(failure));
    }
    let result = run_v3_relay_provider_failure_policy(
        context,
        selected,
        failure.source_stage,
        failure.status,
        Some(failure.policy_error_type.clone()),
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
    let event = build_v3_runtime_provider_failure_observation_from_policy_event(&result.event);
    state.provider_failure_events.push(event.clone());
    if let Some(sink) = state.provider_failure_event_sink {
        let mut observability = state.selected_observability.clone();
        observability.provider_failure_events = state.provider_failure_events.clone();
        sink(&observability, &event);
    }
    failure = attach_v3_provider_failure_events_to_failure(failure, state.provider_failure_events);
    match result.decision.action {
        V3Error05ExecutionAction::WaitThenReselect { recovery } => {
            *state.retry_selected = result.retry_selected.map(|selected| *selected);
            if result.event.wait_ms.is_some() {
                *state.pending_recovery = Some(recovery);
            } else {
                *state.pending_recovery = None;
            }
            Ok(None)
        }
        V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
            *state.retry_selected = result.retry_selected.map(|selected| *selected);
            *state.pending_recovery = Some(recovery);
            Ok(None)
        }
        V3Error05ExecutionAction::ProjectTerminal => {
            failure.terminal_projection = result.terminal_projection;
            Ok(Some(failure))
        }
        V3Error05ExecutionAction::ClientDisconnected
        | V3Error05ExecutionAction::RejectNonProviderError => {
            Err(V3ResponsesRelayRuntimeError::ProviderHealth(
                "provider failure entered a non-provider Error05 lane".to_string(),
            ))
        }
    }
}

fn v3_responses_relay_provider_failure_reason(
    failure: &V3ResponsesRelayProviderFailure,
) -> Option<&str> {
    Some(failure.policy_error_message.as_str()).filter(|message| !message.is_empty())
}

fn v3_provider_failure_error_type_from_body(body: &Value) -> String {
    body.pointer("/error/type")
        .or_else(|| body.pointer("/error/code"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("provider_error")
        .to_string()
}

fn v3_provider_failure_message_from_body(body: &Value) -> String {
    body.pointer("/error/message")
        .or_else(|| body.pointer("/error/type"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("provider failure")
        .to_string()
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
        external_error_kind: None,
        external_error_code: event.error_type.clone(),
        external_error_status: Some(event.status),
        internal_code: None,
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
        canonical_response.get("id").and_then(Value::as_str),
        action,
    )?;
    Ok(())
}

pub async fn execute_v3_responses_relay_dry_run_runtime(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(manifest, input, None, None, None, None)
        .await
        .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_runtime_with_local_continuation(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> crate::V3FoundationRuntimeOutput {
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
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
            control: &stopless_control,
            scope: stopless_scope,
            commit_effects: false,
        }),
        None,
        None,
    )
    .await
    .into_foundation()
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
        None,
        None,
    )
    .await
    .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_runtime_with_local_continuation_stopless_control_and_initial_target(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    initial_selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    initial_expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
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
        Some(initial_selected_target),
        Some(initial_expanded),
    )
    .await
    .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_orchestration_outcome_with_local_continuation_and_stopless_control(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> V3ResponsesRelayDryRunOutcome {
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
        None,
        None,
    )
    .await
}

async fn execute_v3_responses_relay_dry_run_runtime_inner(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    stopless_control: Option<V3ResponsesRelayStoplessControlExecution<'_>>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
) -> V3ResponsesRelayDryRunOutcome {
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3ProviderRequestDryRunNoNetworkTransport::new(
        json!({
            "object": "routecodex.provider_request_dry_run_terminal",
            "terminal_effect": "no_network_send",
            "provider_network_send": false,
            "continuation": {
                "owner": "none",
                "continuable": false
            },
            "message": "routecodex provider-request dry-run stopped before provider send"
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
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::default(),
        None,
        None,
        initial_selected_target,
        initial_expanded,
        BTreeSet::new(),
        None,
    )
    .await
    {
        Ok(output) => output,
        Err(error) => project_v3_responses_relay_runtime_failure(error),
    };
    if let Some(handoff) = output.protocol_direct_handoff.take() {
        return V3ResponsesRelayDryRunOutcome::DirectHandoff(handoff);
    }
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
    let response_payload = json!({
        "object": "routecodex.provider_request_dry_run_terminal",
        "terminal_effect": "no_network_send",
        "provider_network_send": false,
        "continuation": {
            "owner": "none",
            "continuable": false
        },
        "message": "routecodex provider-request dry-run stopped before provider send"
    });
    V3ResponsesRelayDryRunOutcome::Foundation(crate::V3FoundationRuntimeOutput {
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
    })
}

pub fn project_v3_responses_relay_runtime_failure(
    error: V3ResponsesRelayRuntimeError,
) -> V3ResponsesRelayRuntimeOutput {
    match error {
        V3ResponsesRelayRuntimeError::ModelNotFound(message) => {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::ModelNotFound,
                "V3Target10ConcreteProviderSelected",
                "direct_model_not_found",
                message,
            );
            let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
                source: source.clone(),
                action_scope: V3ErrorActionScope::None,
                candidates_remaining: 0,
                source_status: None,
            });
            return V3ResponsesRelayRuntimeOutput {
                status: projected.status,
                client_body: V3ResponsesRelayClientBody::Json(projected.body),
                node_trace: vec!["V3Error06ClientProjected"],
                error_chain: Some(vec![
                    "V3Error01SourceRaised",
                    "V3Error02Classified",
                    "V3Error03TargetLocalAction",
                    "V3Error04TargetExhaustionDecision",
                    "V3Error05ExecutionDecision",
                    "V3Error06ClientProjected",
                ]),
                observability: None,
                stream_observation: None,
                finalized_response: None,
                provider_snapshots: None,
                protocol_direct_handoff: None,
            };
        }
        V3ResponsesRelayRuntimeError::Target(message) => {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::TargetPoolExhausted,
                "V3Target10ConcreteProviderSelected",
                "selected_target_exhausted",
                message,
            );
            let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
                source: source.clone(),
                action_scope: V3ErrorActionScope::None,
                candidates_remaining: 0,
                source_status: None,
            });
            error_output(source, projected.status, "none", Vec::new(), None, 0)
        }
        error => {
            let message = error.to_string();
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRuntime",
                "responses_relay_runtime_error",
                message.clone(),
            );
            error_output(source, 500, "none", Vec::new(), None, 0)
        }
    }
}

struct V3ResponsesRelayJsonResponseHookInput<'a> {
    provider_value: &'a Value,
    provider_semantic_body: &'a Value,
    manifest: &'a V3Config05ManifestPublished,
    server_id: &'a str,
    provider_id: Option<&'a str>,
    provider_protocol: V3HubProviderWireProtocol,
    provider_response_transport_intent: V3HubTransportIntent,
    compatibility_profile: Option<&'a str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    web_search_center_state: Option<V3WebSearchCenterState>,
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
        Option<V3WebSearchCenterState>,
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
        resp02.set_responses_semantic_payload(converted);
    }
    trace.push("V3HubRespInbound02Normalized");
    let response_hook_profile = responses_relay_response_hook_profile(
        input.manifest,
        input.server_id,
        input.stopless_state,
        input.stopless_control_has_client_session_scope,
        input.transition_request_id,
        input.transition_updated_at,
        input.web_search_execution_mode,
    );
    let response_hook_profile = match input.web_search_center_state {
        Some(state) => response_hook_profile.with_web_search_center_state(state),
        None => response_hook_profile,
    };
    let resp03 = hooks.govern(resp02, &response_hook_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    let action = resp04.action();
    let response_stopless_state = resp04.control_transition().cloned();
    let response_web_search_state = resp04.web_search_transition().cloned();
    trace.push("V3HubRespContinuation04Committed");
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04.into_data());
    let finalized_payload = resp05.client_payload().clone();
    trace.push("V3HubRespOutbound05ClientSemantic");
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok((
        action,
        finalized_payload,
        response_stopless_state,
        response_web_search_state,
    ))
}

/// 把搜索 hop 结果投影到客户端可见的 finalized 响应：追加 hosted
/// `web_search_call`（completed、action.search、text_result）与原始
/// call_id 配对的 `function_call_output`。控制状态不进入 payload——
/// 这里投影的是协议等价结果（Codex hosted web_search 契约）。
/// 从搜索 provider 响应提取文本结果：优先 Responses `output[].message
/// .content[].output_text.text`，其次 Chat `choices[].message.content`。
/// Req04 阶段（route 之前）的 Mode B 判定：按请求声明的 model 的编译期
/// `web_search_execution_mode` 解析。请求 model 无法解析时按 `None`（不激活
/// 本地搜索）。selected target 的 mode 由 Resp03 侧 response profile 再校验。
fn resolve_request_web_search_execution_mode(
    manifest: &V3Config05ManifestPublished,
    payload: &Value,
) -> routecodex_v3_config::V3WebSearchExecutionMode {
    let Some(model) = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return routecodex_v3_config::V3WebSearchExecutionMode::None;
    };
    resolve_web_search_mode_and_backend(manifest, model).0
}

/// Mode B 的编译期 backend binding（`provider.model`）：请求 model 的 manifest
/// `web_search_backend_binding`。搜索 hop 用它 direct pin 搜索目标；Mode B 配置
/// 编译期已保证 exactly one binding，这里仅透传（解析失败按 None，由搜索 hop
/// fail-fast）。
fn responses_relay_request_hook_profile(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_state: Option<&V3StoplessCenterState>,
    stopless_control_has_client_session_scope: bool,
    transition_request_id: &str,
    transition_updated_at: u64,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
) -> V3HubServertoolRequestProfile {
    let base = if web_search_execution_mode.is_metadata_center_local_search() {
        // Mode B：Req04 需在工具面含标准 web_search 声明时激活 websearch
        // ServerTool 实例（LocalToolSurfaceActive），供 Resp03 同轮拦截。
        V3HubServertoolRequestProfile::enabled(["servertool.request"])
            .with_web_search_execution_mode(web_search_execution_mode)
    } else {
        V3HubServertoolRequestProfile::disabled()
    };
    if !v3_stopless_center_enabled_for_server(manifest, server_id)
        || !stopless_control_has_client_session_scope
    {
        return base;
    }
    let mut profile = V3HubServertoolRequestProfile::stopless_reasoning_stop()
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
    if web_search_execution_mode.is_metadata_center_local_search() {
        profile = profile.with_web_search_execution_mode(web_search_execution_mode);
    }
    match stopless_state {
        Some(state) => profile.with_stopless_center_state(state.clone()),
        None => profile,
    }
}

fn responses_relay_response_hook_profile(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_state: Option<&V3StoplessCenterState>,
    stopless_control_has_client_session_scope: bool,
    transition_request_id: &str,
    transition_updated_at: u64,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
) -> V3HubRelayResponseHookProfile {
    let profile = if web_search_execution_mode
        == routecodex_v3_config::V3WebSearchExecutionMode::NativeRemoteSearchToolMix
        || web_search_execution_mode.is_metadata_center_local_search()
    {
        // Mode A（原生搜索）与 Mode B（本地 ServerToolCenter 治理）都不走
        // 客户端 exec_command 投影；Resp03 按 profile.mode 分别处理。
        V3HubRelayResponseHookProfile::empty()
            .with_web_search_execution_mode(web_search_execution_mode)
    } else {
        // 未声明 web_search 执行模式的兼容路径：保持既有 exec_command 投影。
        V3HubRelayResponseHookProfile::empty().with_servertool_name("web_search")
    };
    if !v3_stopless_center_enabled_for_server(manifest, server_id)
        || !stopless_control_has_client_session_scope
    {
        return profile;
    }
    let profile = profile
        .with_stopless_reasoning_stop()
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
    match stopless_state {
        Some(state) => profile.with_stopless_center_state(state.clone()),
        None => profile,
    }
}

fn load_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
) -> Result<Option<V3StoplessCenterState>, V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled_for_server(manifest, server_id) {
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
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    state: V3StoplessCenterState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled_for_server(manifest, server_id) {
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
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled_for_server(manifest, server_id) {
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
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    response_stopless_state: Option<V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    match response_stopless_state {
        Some(state) => store_v3_responses_relay_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            state,
        ),
        None => {
            clear_v3_responses_relay_stopless_control_state(manifest, server_id, stopless_control)
        }
    }
}

fn apply_v3_responses_relay_stopless_control_request_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    restored_state_loaded: bool,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    match request_stopless_state {
        Some(state) => store_v3_responses_relay_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            state.clone(),
        ),
        None if restored_state_loaded => {
            clear_v3_responses_relay_stopless_control_state(manifest, server_id, stopless_control)
        }
        None => Ok(()),
    }
}

/// Mode B：Req04 激活的 websearch ServerTool 实例（LocalToolSurfaceActive）
/// 存入 relay ServerToolCenter websearch 桶，供 Resp03 同轮拦截判定。
/// 未激活时不做任何写（不存在"清除未激活状态"的语义）。
fn apply_v3_responses_relay_web_search_control_request_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    request_web_search_state: Option<&V3WebSearchCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(state) = request_web_search_state else {
        return Ok(());
    };
    // web_search 与 stopless 解耦：web_search 配对状态存桶不依赖 stopless
    // feature gate 或 client session scope（stopless 与 web_search 唯一关系是
    // 都使用 servertool center 存储；web_search 自己的配对生命周期独立）。
    let Some(stopless_control) = stopless_control else {
        return Ok(());
    };
    if !stopless_control.commit_effects {
        return Ok(());
    }
    stopless_control
        .control
        .web_search_store_for_scope(&stopless_control.scope, state.clone())
}

fn clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if request_stopless_state.is_none() {
        return Ok(());
    }
    clear_v3_responses_relay_stopless_control_state(manifest, server_id, stopless_control)
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

fn anthropic_cyber_refusal_error_from_payload(
    payload: &Value,
) -> Option<V3ProviderSemanticErrorProjection> {
    let direct = payload.as_object();
    let delta = payload.get("delta").and_then(Value::as_object);
    let candidate = [direct, delta]
        .into_iter()
        .flatten()
        .find(|object| anthropic_cyber_refusal_object_matches(object))?;
    let explanation = candidate
        .get("stop_details")
        .and_then(Value::as_object)
        .and_then(|details| details.get("explanation"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Anthropic returned a cyber-category refusal.");
    Some(V3ProviderSemanticErrorProjection {
        code: V3_ANTHROPIC_CYBER_REFUSAL_CODE.to_string(),
        message: format!(
            "Anthropic cyber refusal is treated as retryable provider saturation: {explanation}"
        ),
    })
}

fn anthropic_cyber_refusal_object_matches(object: &Map<String, Value>) -> bool {
    let stop_reason = object
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    if stop_reason.as_deref() != Some("refusal") {
        return false;
    }
    object
        .get("stop_details")
        .and_then(Value::as_object)
        .and_then(|details| details.get("category"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
        == Some("cyber")
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
    if object.get("type").and_then(Value::as_str) == Some("custom") {
        let custom = object
            .get("custom")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat custom tool_call.custom must be an object before Responses projection"
                        .to_string(),
                )
            })?;
        let name = custom
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat custom tool name is required before Responses projection"
                        .to_string(),
                )
            })?;
        if !custom_tool_names.contains(name) {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat custom tool response requires an active governed custom declaration"
                    .to_string(),
            ));
        }
        let input = custom.get("input").and_then(Value::as_str).ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat custom tool input must be a string before Responses projection"
                    .to_string(),
            )
        })?;
        return Ok(json!({
            "type":"custom_tool_call",
            "call_id":call_id,
            "name":name,
            "input":input
        }));
    }
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
    if name == "tool_search" {
        let arguments = parse_v3_openai_chat_tool_call_arguments_object(name, arguments)?;
        return Ok(json!({
            "type":"tool_search_call",
            "call_id":call_id,
            "execution":"client",
            "arguments":arguments
        }));
    }
    if custom_tool_names.contains(name) {
        // 请求侧 custom -> function 扁平化后，provider 返回 function tool_call；
        // 按客户端声明的 custom 名归类回 custom_tool_call，保持客户端契约。
        return Ok(json!({
            "type":"custom_tool_call",
            "call_id":call_id,
            "name":name,
            "input":arguments
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
        timing: None,
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

fn infer_v3_runtime_response_status_from_provider_event_type(
    event_type: Option<&str>,
) -> Option<String> {
    match event_type {
        Some("response.completed") => Some("completed".to_string()),
        Some("response.requires_action") => Some("requires_action".to_string()),
        Some("response.failed") => Some("failed".to_string()),
        Some("response.incomplete") => Some("incomplete".to_string()),
        Some("response.cancelled" | "response.canceled") => Some("cancelled".to_string()),
        Some("response.error") => Some("error".to_string()),
        _ => None,
    }
}

fn infer_v3_runtime_finish_reason_from_provider_event_json(
    event_type: Option<&str>,
    response_status: Option<&str>,
) -> Option<String> {
    match response_status.map(str::trim) {
        Some(status) if status.eq_ignore_ascii_case("requires_action") => {
            Some("tool_calls".to_string())
        }
        Some(status)
            if status.eq_ignore_ascii_case("completed")
                && matches!(event_type, Some("response.completed")) =>
        {
            Some("stop".to_string())
        }
        _ => None,
    }
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
    let data =
        serde_json::to_string(payload).expect("serde_json::Value serialization must not fail");
    format!("event: {event}\ndata: {data}\n\n").into_bytes()
}

mod provider_stream_materialization;
mod responses_provider_event_codec;

use provider_stream_materialization::*;
pub use provider_stream_materialization::{
    materialize_v3_provider_sse_as_canonical_response,
    materialize_v3_responses_provider_sse_as_canonical_response,
};
use responses_provider_event_codec::*;
pub(crate) fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(
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
                    if let Err(error) = append_v3_responses_client_function_call_progress_frames(
                        &mut frames,
                        response_id,
                        index,
                        &projected_item,
                    ) {
                        frames.push(Err(error));
                        return Box::pin(stream::iter(frames));
                    }
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
        let completed_response = project_v3_responses_client_completed_response(&response);
        frames.push(Ok(build_v3_runtime_sse_json_frame(
            "response.completed",
            &json!({
                "type": "response.completed",
                "response": completed_response,
            }),
        )));
        frames.push(Ok(build_v3_runtime_sse_json_frame(
            "response.done",
            &json!({
                "type": "response.done",
                "response": completed_response,
            }),
        )));
    }
    frames.push(Ok(b"data: [DONE]\n\n".to_vec()));
    Box::pin(stream::iter(frames))
}

fn append_v3_responses_client_function_call_progress_frames(
    frames: &mut Vec<Result<Vec<u8>, String>>,
    response_id: &str,
    output_index: usize,
    item: &Value,
) -> Result<(), String> {
    let item_type = item.get("type").and_then(Value::as_str);
    if !matches!(
        item_type,
        Some("function_call" | "custom_tool_call" | "tool_call" | "tool_search_call")
    ) {
        return Ok(());
    }
    let mut added_item = item.clone();
    if item_type == Some("function_call") {
        if let Some(object) = added_item.as_object_mut() {
            object.insert("arguments".to_string(), Value::String(String::new()));
        }
    }
    frames.push(Ok(build_v3_runtime_sse_json_frame(
        "response.output_item.added",
        &json!({
            "type": "response.output_item.added",
            "response_id": response_id,
            "output_index": output_index,
            "item": added_item,
        }),
    )));
    if item_type != Some("function_call") {
        return Ok(());
    }
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "V3 Responses Relay client SSE function_call item is missing call_id".to_string()
        })?;
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "V3 Responses Relay client SSE function_call item {call_id} is missing string arguments"
            )
        })?;
    frames.push(Ok(build_v3_runtime_sse_json_frame(
        "response.function_call_arguments.done",
        &json!({
            "type": "response.function_call_arguments.done",
            "response_id": response_id,
            "output_index": output_index,
            "call_id": call_id,
            "arguments": arguments,
        }),
    )));
    Ok(())
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

/// SSE 事件级 completed/done 内嵌 response 的 item 表示投影：与
/// `output_item.done` 事件保持一致（output_text -> message 包裹），
/// 避免同一 SSE 流内同一 output 条目出现两种 client 语义。
fn project_v3_responses_client_completed_response(response: &Value) -> Value {
    let mut projected = response.clone();
    if let Some(output) = projected.get_mut("output").and_then(Value::as_array_mut) {
        for item in output.iter_mut() {
            *item = project_v3_responses_client_event_output_item_done_item(item);
        }
    }
    projected
}

pub(crate) fn provider_target(
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
    let secret = match (&auth.env, &auth.token_file, &auth.api_key) {
        (Some(env), None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
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
        provider_request_cleanup: selected.provider_request_cleanup.clone(),
        request_timeout_ms: provider.request_timeout_ms,
        initial_concurrency_budget: selected.initial_concurrency_budget,
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

fn allowed_execution_modes_for_relay_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Result<Vec<String>, V3ResponsesRelayRuntimeError> {
    let server = manifest.servers.get(server_id).ok_or_else(|| {
        V3ResponsesRelayRuntimeError::Target(format!("server {server_id} missing"))
    })?;
    Ok(server
        .execution
        .as_ref()
        .map(|execution| execution.allowed_modes.clone())
        .unwrap_or_else(|| vec!["relay".to_string()]))
}

fn provider_http_failure(
    status: u16,
    body: &[u8],
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    let body = serde_json::from_slice::<Value>(body)
        .unwrap_or_else(|_| json!({"error":{"type":"provider_error","message":"provider error"}}));
    let policy_error_type = v3_provider_failure_error_type_from_body(&body);
    let policy_error_message = v3_provider_failure_message_from_body(&body);
    V3ResponsesRelayProviderFailure {
        status,
        policy_error_type,
        policy_error_message,
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        observability,
        terminal_projection: None,
    }
}

fn provider_runtime_failure(
    error: V3ProviderError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    let terminal_projection =
        matches!(&error, V3ProviderError::ClientDisconnect { .. }).then(|| {
            project_v3_client_disconnect(
                provider_id,
                provider_runtime_failure_stage(&error),
                error.to_string(),
            )
        });
    let policy_error_message = error.to_string();
    V3ResponsesRelayProviderFailure {
        status: if terminal_projection.is_some() {
            499
        } else {
            502
        },
        policy_error_type: "provider_runtime_error".to_string(),
        policy_error_message: policy_error_message.clone(),
        provider_id: provider_id.to_string(),
        source_stage: provider_runtime_failure_stage(&error),
        observability,
        terminal_projection,
    }
}

fn provider_semantic_failure(
    status: u16,
    error: V3ProviderSemanticErrorProjection,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    let policy_error_type = error.code.clone();
    let policy_error_message = error.message.clone();
    V3ResponsesRelayProviderFailure {
        status,
        policy_error_type,
        policy_error_message,
        provider_id: provider_id.to_string(),
        source_stage: "V3ProviderRespInbound01Raw",
        observability,
        terminal_projection: None,
    }
}

fn provider_response_stream_relay_failure(
    error: V3ResponsesRelayRuntimeError,
    request_id: &str,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    match error {
        V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
            status,
            code,
            message,
        } => V3ResponsesRelayProviderFailure {
            status,
            policy_error_type: code.clone(),
            policy_error_message: message.clone(),
            provider_id: provider_id.to_string(),
            source_stage: "V3ProviderRespInbound01Raw",
            observability,
            terminal_projection: None,
        },
        other => provider_runtime_failure(
            provider_response_stream_failure(other, request_id, provider_id),
            provider_id,
            observability,
        ),
    }
}

fn provider_request_relay_failure(
    error: V3ResponsesRelayRuntimeError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> Result<V3ResponsesRelayProviderFailure, V3ResponsesRelayRuntimeError> {
    let (source_stage, error_type, message) = match error {
        V3ResponsesRelayRuntimeError::ProviderCompat(error) => (
            "ProviderReqCompat06ProviderCompat",
            "provider_request_compat_error",
            format!("V3 Responses Relay provider compat failed: {error}"),
        ),
        V3ResponsesRelayRuntimeError::ProviderWireEncoding(message) => (
            "V3ProviderReqOutbound08WirePayload",
            "provider_request_wire_error",
            format!("V3 Responses Relay provider wire encoding failed: {message}"),
        ),
        V3ResponsesRelayRuntimeError::Provider(error) => (
            "V3ProviderReqOutbound08WirePayload",
            "provider_request_wire_error",
            error.to_string(),
        ),
        other => return Err(other),
    };
    Ok(V3ResponsesRelayProviderFailure {
        status: 502,
        policy_error_type: error_type.to_string(),
        policy_error_message: message.clone(),
        provider_id: provider_id.to_string(),
        source_stage,
        observability,
        terminal_projection: None,
    })
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
            | V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure { .. }
            | V3ResponsesRelayRuntimeError::Response(
                V3HubRelayResponseError::ProviderResponseNotObject
                    | V3HubRelayResponseError::SideChannelLeaked { .. }
                    | V3HubRelayResponseError::ProviderResponseOutputNotArray
                    | V3HubRelayResponseError::MalformedToolCall { .. }
                    | V3HubRelayResponseError::MissingStatus
                    | V3HubRelayResponseError::UnsupportedStatus { .. }
                    | V3HubRelayResponseError::ProviderProtocolResponseMalformed { .. }
                    | V3HubRelayResponseError::ProviderCompatFailed { .. }
            )
    )
}

fn provider_response_hook_failure(
    error: V3ResponsesRelayRuntimeError,
    provider_id: &str,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayProviderFailure {
    match error {
        V3ResponsesRelayRuntimeError::Provider(error) => {
            provider_runtime_failure(error, provider_id, observability)
        }
        other => {
            let message = format!("provider response event codec failed: {other}");
            V3ResponsesRelayProviderFailure {
                status: 502,
                policy_error_type: "provider_response_event_codec_failure".to_string(),
                policy_error_message: message.clone(),
                provider_id: provider_id.to_string(),
                source_stage: "V3HubRespChatProcess03Governed",
                observability,
                terminal_projection: None,
            }
        }
    }
}

fn provider_failure_output(
    failure: V3ResponsesRelayProviderFailure,
    mut trace: Vec<&'static str>,
    _candidates_remaining: usize,
) -> V3ResponsesRelayRuntimeOutput {
    let projected = failure
        .terminal_projection
        .expect("terminal Responses provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    let mut observability = failure.observability;
    if let Some(observability) = observability.as_mut() {
        observability.response_status = Some("error".to_string());
        if observability.provider_status.is_none() {
            observability.provider_status = Some(failure.status);
        }
        if observability.provider_id.is_none() && failure.provider_id != "none" {
            observability.provider_id = Some(failure.provider_id);
        }
    }
    V3ResponsesRelayRuntimeOutput {
        status: projected.status,
        client_body: V3ResponsesRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
        observability,
        stream_observation: None,
        finalized_response: None,
        provider_snapshots: None,
        protocol_direct_handoff: None,
    }
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    provider_id: &str,
    mut trace: Vec<&'static str>,
    mut observability: Option<V3RuntimeObservability>,
    candidates_remaining: usize,
) -> V3ResponsesRelayRuntimeOutput {
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
        finalized_response: None,
        provider_snapshots: None,
        protocol_direct_handoff: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{stream, StreamExt};
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_provider_responses::build_v3_transport_13_responses_http_request_from_parts;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RelayOnlyFailureTransport {
        sends: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl ResponsesTransport for RelayOnlyFailureTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            assert_eq!(request.provider_id(), "relay_first");
            self.sends.fetch_add(1, Ordering::SeqCst);
            Err(V3ProviderError::Transport {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                reason: "relay target failed before direct target".to_string(),
            })
        }
    }

    fn relay_to_direct_reselection_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.relay_first]
type = "openai_chat"
base_url = "http://relay.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "RELAY_FIRST_KEY" }] }
[providers.relay_first.models.test]
wire_name = "wire-relay-first"

[providers.direct_second]
type = "responses"
base_url = "http://direct.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "DIRECT_SECOND_KEY" }] }
[providers.direct_second.models.test]
wire_name = "wire-direct-second"

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "relay_first", model = "test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "direct_second", model = "test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
        )
        .expect("relay-to-direct authoring");
        compile_v3_config_05_manifest(authoring).expect("relay-to-direct manifest")
    }

    fn anthropic_then_openai_chat_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.anthropic_first]
type = "anthropic"
base_url = "http://anthropic.invalid/v1"
default_model = "claude-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "ANTHROPIC_FIRST_KEY" }] }
[providers.anthropic_first.models.claude-test]
wire_name = "claude-test"
capabilities = ["text", "tools"]

[providers.openai_second]
type = "openai_chat"
base_url = "http://openai.invalid/v1"
default_model = "chat-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "OPENAI_SECOND_KEY" }] }
[providers.openai_second.models.chat-test]
wire_name = "chat-test"
capabilities = ["text", "tools"]

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "anthropic_first", model = "claude-test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "openai_second", model = "chat-test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
        )
        .expect("mixed protocol authoring");
        compile_v3_config_05_manifest(authoring).expect("mixed protocol manifest")
    }

    struct RecordingChatTransport {
        provider_ids: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl ResponsesTransport for RecordingChatTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            self.provider_ids
                .lock()
                .expect("provider id recorder")
                .push(request.provider_id().to_string());
            let response = if request.provider_id() == "openai_second" {
                br#"{"id":"chatcmpl_static_projection","object":"chat.completion","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#.to_vec()
            } else {
                br#"{"id":"msg_static_projection","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#.to_vec()
            };
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                response,
            ))
        }
    }

    #[tokio::test]
    async fn target_protocol_unmapped_field_skips_invalid_wire_and_switches_provider() {
        std::env::set_var("ANTHROPIC_FIRST_KEY", "anthropic-secret");
        std::env::set_var("OPENAI_SECOND_KEY", "openai-secret");
        let manifest = anthropic_then_openai_chat_manifest();
        let session_scope =
            V3ProviderFailureSessionScope::new("test", "default", "protocol-incompatible-session")
                .expect("session scope");
        let transport = RecordingChatTransport {
            provider_ids: Mutex::new(Vec::new()),
        };

        let output = execute_v3_responses_relay_runtime_inner(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "test".to_string(),
                failure_session_scope: session_scope,
                request_id: "req-unmapped-field-no-switch".to_string(),
                payload: json!({
                    "model": "client-model",
                    "input": "hello",
                    "store": true
                }),
            },
            &transport,
            None,
            None,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
            V3ResponsesRelayRetryPolicy::default(),
            None,
            None,
            None,
            None,
            BTreeSet::new(),
            None,
        )
        .await
        .expect("unmapped target field must skip the incompatible candidate and continue");

        assert_eq!(output.status, 200);
        assert!(
            output
                .node_trace
                .iter()
                .any(|node| *node == "V3TargetLocalReselected"),
            "target protocol projection failure must enter the typed provider-switch path"
        );
        assert_eq!(
            transport
                .provider_ids
                .lock()
                .expect("provider ids")
                .as_slice(),
            ["openai_second"],
            "the incompatible Anthropic candidate must receive no wire request"
        );
    }

    #[test]
    fn missing_execution_block_preserves_relay_mode() {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.relay]
type = "openai_chat"
base_url = "http://relay.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "RELAY_KEY" }] }
[providers.relay.models.test]
wire_name = "wire-relay"

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "relay", model = "test", key = "key", priority = 1 }]
"#,
        )
        .expect("relay-only authoring");
        let manifest = compile_v3_config_05_manifest(authoring).expect("relay-only manifest");

        assert_eq!(
            allowed_execution_modes_for_relay_server(&manifest, "test").unwrap(),
            vec!["relay".to_string()]
        );
    }

    #[tokio::test]
    async fn relay_reselect_can_handoff_to_direct_target_after_provider_failure() {
        std::env::set_var("RELAY_FIRST_KEY", "relay-secret");
        std::env::set_var("DIRECT_SECOND_KEY", "direct-secret");
        let manifest = relay_to_direct_reselection_manifest();
        let session_scope =
            V3ProviderFailureSessionScope::new("test", "default", "relay-direct-session")
                .expect("session scope");
        let transport = RelayOnlyFailureTransport {
            sends: AtomicUsize::new(0),
        };
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            execute_v3_responses_relay_runtime_inner(
                &manifest,
                V3ResponsesRelayRuntimeInput {
                    server_id: "test".to_string(),
                    failure_session_scope: session_scope,
                    request_id: "req-relay-direct".to_string(),
                    payload: json!({"model":"client-model","input":"hello"}),
                },
                &transport,
                None,
                None,
                V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
                V3ResponsesRelayRetryPolicy::default(),
                None,
                None,
                None,
                None,
                BTreeSet::new(),
                None,
            ),
        )
        .await
        .expect("relay failure handoff must not wait for normal cooldown")
        .expect("relay failure should hand off to Direct target");

        assert_eq!(transport.sends.load(Ordering::SeqCst), 1);
        let handoff = output
            .protocol_direct_handoff
            .expect("same-protocol reselected target must hand off to Direct");
        assert_eq!(
            handoff.plan.decision.mode,
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        );
        assert_eq!(
            handoff.plan.decision.target.candidate.provider_id,
            "direct_second"
        );
        assert_eq!(
            handoff.observability_accumulator.attempts(),
            1,
            "Relay-to-Direct handoff must carry the completed provider attempt",
        );
        assert!(handoff
            .plan
            .request_local_excluded_candidates
            .contains("relay_first:key:test"));
        assert!(handoff.node_trace.contains(&"V3TargetLocalReselected"));
        assert!(handoff.provider_failure_events.len() == 1);
        assert!(
            handoff.request_payload.get("input").is_some(),
            "Direct handoff must carry the ReqChatProcess result projected by the adjacent Responses outbound codec"
        );
        assert!(
            handoff.request_payload.get("messages").is_none(),
            "Chat canonical fields must not cross the typed Direct handoff"
        );
    }

    #[test]
    fn relay_local_tool_output_cannot_enter_fresh_protocol_switch() {
        let payload = json!({
            "model": "client-model",
            "input": [{
                "type": "function_call_output",
                "call_id": "call_relay_owned",
                "output": "done"
            }]
        });
        let ids = find_responses_tool_output_ids(&payload).expect("tool output ids");

        assert!(!ids.restore_ids.is_empty());
        assert!(
            !responses_relay_protocol_switch_allowed(&payload, &ids),
            "Relay-owned local continuation must remain in Relay after ReqChatProcess restore"
        );
    }

    #[test]
    fn relay_local_tool_output_consumes_previous_response_and_call_id_aliases() {
        let payload = json!({
            "previous_response_id": "resp_relay_owned",
            "input": [{
                "type": "function_call_output",
                "call_id": "call_relay_owned",
                "output": "done"
            }]
        });
        let ids = find_responses_tool_output_ids(&payload).expect("tool output ids");

        assert_eq!(ids.restore_ids, vec!["call_relay_owned"]);
        assert_eq!(
            ids.consumed_ids,
            vec!["resp_relay_owned", "call_relay_owned"]
        );
    }

    #[test]
    fn provider_response_failure_classifier_keeps_provider_and_local_hook_errors_separate() {
        let malformed_tool =
            V3ResponsesRelayRuntimeError::Response(V3HubRelayResponseError::MalformedToolCall {
                index: 5,
                reason: "duplicate call_id/id",
            });
        assert!(is_v3_responses_provider_response_failure(&malformed_tool));
        let resp03_failure = provider_response_hook_failure(malformed_tool, "controlled", None);
        assert_eq!(
            resp03_failure.source_stage,
            "V3HubRespChatProcess03Governed"
        );
        assert_eq!(
            resp03_failure.policy_error_type,
            "provider_response_event_codec_failure"
        );
        assert!(
            resp03_failure
                .policy_error_message
                .contains("duplicate call_id/id"),
            "{}",
            resp03_failure.policy_error_message
        );

        let provider_raw_failure = provider_response_hook_failure(
            V3ResponsesRelayRuntimeError::Provider(V3ProviderError::ResponseBody {
                request_id: "req-provider-raw".to_string(),
                provider_id: "controlled".to_string(),
                reason: "controlled provider response body failure".to_string(),
            }),
            "controlled",
            None,
        );
        assert_eq!(
            provider_raw_failure.source_stage,
            "V3ProviderRespInbound01Raw"
        );
        assert!(is_v3_responses_provider_response_failure(
            &V3ResponsesRelayRuntimeError::Response(
                V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                    protocol: "responses",
                    reason: "output must preserve provider tool identity",
                }
            )
        ));
        assert!(!is_v3_responses_provider_response_failure(
            &V3ResponsesRelayRuntimeError::Response(V3HubRelayResponseError::ExecutionModeNotRelay)
        ));
        assert!(!is_v3_responses_provider_response_failure(
            &V3ResponsesRelayRuntimeError::Response(
                V3HubRelayResponseError::StoplessProjectionFailed {
                    reason: "missing local transition context",
                }
            )
        ));
    }

    #[test]
    fn anthropic_provider_signature_delta_without_string_fails_explicitly() {
        let mut state = V3AnthropicProviderStreamState::default();
        collect_v3_anthropic_provider_stream_event(
            json!({
                "type":"message_start",
                "message":{
                    "id":"msg_signature",
                    "type":"message",
                    "role":"assistant",
                    "content":[],
                    "usage":{"input_tokens":1}
                }
            }),
            &mut state,
        )
        .expect("message_start");
        collect_v3_anthropic_provider_stream_event(
            json!({
                "type":"content_block_start",
                "index":0,
                "content_block":{"type":"thinking","thinking":""}
            }),
            &mut state,
        )
        .expect("thinking start");

        let error = collect_v3_anthropic_provider_stream_event(
            json!({
                "type":"content_block_delta",
                "index":0,
                "delta":{"type":"signature_delta","signature":null}
            }),
            &mut state,
        )
        .expect_err("malformed signature_delta must not disappear");

        assert!(error
            .to_string()
            .contains("Anthropic codec malformed reasoning content"));
    }

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
    async fn responses_relay_routes_current_user_thinking_after_chat_canonicalization() {
        std::env::set_var("GLM_TEST_KEY", "secret-key");
        std::env::set_var("MINIMAX_TEST_KEY", "secret-key");
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[servers.s.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

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
match = { precedence = 1, entry_protocol = "responses" }
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
                failure_session_scope: V3ProviderFailureSessionScope::new(
                    "s",
                    "g",
                    "session-responses-relay-test",
                )
                .expect("test failure session scope"),
                request_id: "req_reasoning_original_surface_route".to_string(),
                payload: json!({
                    "model": "gpt-5.5",
                    "input": [{"type":"message","role":"user","content":"please explain the reasoning step by step"}],
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
        std::env::remove_var("GLM_TEST_KEY");
        std::env::remove_var("MINIMAX_TEST_KEY");
    }

    #[tokio::test]
    async fn responses_relay_unknown_direct_provider_model_projects_404() {
        std::env::set_var("MINIMAX_TEST_KEY", "secret-key");
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[servers.s.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.minimax]
type = "openai_chat"
base_url = "https://minimax.example/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_TEST_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
capabilities = ["text", "tools"]

[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .expect("config authoring");
        let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
        let output = execute_v3_responses_relay_dry_run_runtime(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "s".to_string(),
                failure_session_scope: V3ProviderFailureSessionScope::new(
                    "s",
                    "g",
                    "session-responses-relay-404",
                )
                .expect("test failure session scope"),
                request_id: "req_unknown_direct_provider_model".to_string(),
                payload: json!({
                    "model": "minimax.unknown-model",
                    "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],
                    "stream": false
                }),
            },
        )
        .await;

        assert_eq!(output.status, 404);
        assert!(
            output
                .node_trace
                .iter()
                .any(|node| *node == "V3Error06ClientProjected"),
            "404 must project through the Error chain: {:?}",
            output.node_trace
        );
        std::env::remove_var("MINIMAX_TEST_KEY");
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
    fn openai_chat_web_search_function_call_remains_pending_local_servertool_call() {
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
        .expect("OpenAI Chat function web_search must remain pending for Resp03 ServerTool interception");

        assert_eq!(response["status"], "requires_action");
        assert_eq!(response["output"][0]["type"], "function_call");
        assert_eq!(response["output"][0]["call_id"], "call_web_search");
        assert_eq!(response["output"][0]["name"], "web_search");
        assert_eq!(
            response["output"][0]["arguments"],
            "{\"query\":\"RouteCodex docs\"}"
        );
        assert!(response["output"][0].get("status").is_none());
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
                            "type": "custom",
                            "custom": {
                                "name": "exec",
                                "input": "pwd"
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
    fn openai_chat_custom_tool_response_round_trips_to_responses_custom_call() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_apply_patch",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": "call_apply_patch",
                            "type": "custom",
                            "custom": {
                                "name": "apply_patch",
                                "input": "*** Begin Patch\n*** End Patch"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            &json!({
                "tools": [{
                    "type":"custom",
                    "name":"apply_patch",
                    "format":{"type":"grammar","syntax":"lark","definition":"start: patch"}
                }]
            }),
        )
        .expect("Chat function projection must reverse to the declared Responses custom tool");

        assert_eq!(response["status"], "requires_action");
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["name"], "apply_patch");
        assert_eq!(
            response["output"][0]["input"],
            "*** Begin Patch\n*** End Patch"
        );
    }

    #[test]
    fn openai_chat_function_tool_call_with_custom_declared_name_round_trips_as_custom_call() {
        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &json!({
                "id": "chatcmpl_apply_patch_flattened",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": "call_apply_patch_2",
                            "type": "function",
                            "function": {
                                "name": "apply_patch",
                                "arguments": "{\"patch\":\"*** Begin Patch\\n*** End Patch\"}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            &json!({
                "tools": [{"type":"custom","name":"apply_patch"}]
            }),
        )
        .expect("flattened function tool_call must reverse to the declared Responses custom tool");

        assert_eq!(response["status"], "requires_action");
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["name"], "apply_patch");
        assert_eq!(
            response["output"][0]["input"],
            "{\"patch\":\"*** Begin Patch\\n*** End Patch\"}"
        );
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
    fn explicit_target_exhaustion_projection_is_compact() {
        let output =
            project_v3_responses_relay_runtime_failure(V3ResponsesRelayRuntimeError::Target(
                "selected target exhausted after [\"routecodex:key1:deepseek-v4-flash:availability(cooldown)\"]"
                    .to_string(),
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
            "selected target exhausted after [\"routecodex:key1:deepseek-v4-flash:availability(cooldown)\"]"
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
        assert_eq!(body["error"]["code"], "responses_relay_runtime_error");
        assert_eq!(body["error"]["class"], "runtime_failure");
        assert_eq!(body["error"]["stage"], "V3HubRuntime");
        assert_eq!(body["error"]["decision"], "project_client_error");
        assert_eq!(body["error"]["target_exhausted"], true);
        assert_eq!(body["error"]["candidates_remaining"], 0);
        assert_eq!(body["error"]["error_node"], "V3Error06ClientProjected");
        assert_eq!(
            body["error"]["message"],
            "V3 Hub static hook registry failed: registry unavailable"
        );
        assert_eq!(
            output.error_chain.as_deref(),
            Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
        );
    }

    #[test]
    fn provider_failure_output_projects_error_chain_body_without_success_wrapping() {
        let terminal_projection = V3ErrorHandlingCenter::project_terminal_decision(
            V3ErrorHandlingCenter::decide_provider(
                V3ErrorHandlingCenterInput {
                    source: routecodex_v3_error::build_v3_error_01_source_raised_external(
                        V3ErrorSourceKind::ProviderFailure,
                        "V3ProviderReqOutbound09TransportRequest",
                        "rate_limit_error",
                        "controlled rate limit",
                        routecodex_v3_error::V3ExternalErrorLink {
                            kind: routecodex_v3_error::V3ExternalErrorKind::Provider,
                            status: Some(429),
                            code: Some("rate_limit_error".to_string()),
                            provider_id: Some("controlled".to_string()),
                            upstream_request_id: None,
                            message: Some("controlled rate limit".to_string()),
                        },
                    ),
                    action_scope: V3ErrorActionScope::ProviderInstance {
                        provider_id: "controlled".to_string(),
                    },
                    candidates_remaining: 0,
                    source_status: Some(429),
                },
                false,
                false,
                None,
            )
            .try_into_terminal()
            .expect("explicit route/default exhaustion proof must yield terminal Error05"),
        );
        let output = provider_failure_output(
            V3ResponsesRelayProviderFailure {
                status: 429,
                policy_error_type: "rate_limit_error".to_string(),
                policy_error_message: "controlled rate limit".to_string(),
                provider_id: "controlled".to_string(),
                source_stage: "V3ProviderReqOutbound09TransportRequest",
                terminal_projection: Some(terminal_projection),
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
    async fn provider_sse_done_without_completed_is_terminal_missing() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()),
            Ok(b"event: response.done\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
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
    async fn provider_sse_requires_action_without_completed_is_terminal_missing() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.requires_action\ndata: {\"type\":\"response.requires_action\",\"response\":{\"id\":\"resp_required\",\"status\":\"requires_action\"},\"required_action\":{\"type\":\"submit_tool_outputs\"}}\n\n".to_vec(),
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
    async fn client_sse_function_call_projection_missing_call_id_fails_explicitly() {
        let projected = collect_projected_sse(
            build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(json!({
                "id": "resp_bad_call_id",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }]
            })),
        )
        .await;
        let error = projected
            .into_iter()
            .find_map(Result::err)
            .expect("missing call_id must fail before terminal success");

        assert!(
            error.contains("missing call_id"),
            "missing function_call call_id must be an explicit SSE projection error: {error}"
        );
    }

    #[tokio::test]
    async fn client_sse_function_call_projection_missing_arguments_fails_explicitly() {
        let projected = collect_projected_sse(
            build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(json!({
                "id": "resp_bad_arguments",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_missing_args",
                    "name": "exec_command"
                }]
            })),
        )
        .await;
        let error = projected
            .into_iter()
            .find_map(Result::err)
            .expect("missing arguments must fail before terminal success");

        assert!(
            error.contains("missing string arguments"),
            "missing function_call arguments must be an explicit SSE projection error: {error}"
        );
    }

    #[tokio::test]
    async fn client_sse_completed_response_projects_output_text_items_to_message_shape() {
        // 同一 SSE 流内 completed/done 内嵌 response 的 output item 必须与
        // output_item.done 一致（output_text -> message 包裹），不允许同一
        // output 条目出现两种 client 语义。
        let projected = collect_projected_sse(
            build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(json!({
                "id": "resp_completed_shape",
                "status": "completed",
                "output": [{"type": "output_text", "text": "done"}]
            })),
        )
        .await;
        let text: String = projected
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .expect("SSE projection must not error")
            .join("\n");
        let completed = text
            .find("event: response.completed")
            .map(|index| &text[index..])
            .expect("response.completed frame must be present");
        assert!(
            completed.contains(r#""output":[{"content":[{"text":"done","type":"output_text"}],"role":"assistant","type":"message"}]"#),
            "completed response.output must use message shape consistent with output_item.done: {completed}"
        );
        let done = text
            .find("event: response.done")
            .map(|index| &text[index..])
            .expect("response.done frame must be present");
        assert!(
            done.contains(r#""output":[{"content":[{"text":"done","type":"output_text"}],"role":"assistant","type":"message"}]"#),
            "done response.output must use message shape consistent with output_item.done: {done}"
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
    async fn anthropic_provider_sse_uses_responses_projection_context_for_metadata_and_custom_tools(
    ) {
        let observation = V3RuntimeStreamObservation::default();
        let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "tools":[{
                "type":"custom",
                "name":"apply_patch",
                "description":"apply a patch"
            }],
            "routecodex_chat_extension":{
                "responses_request":{
                    "metadata":{"trace_id":"sse-context-kept"}
                }
            }
        }))
        .expect("projection context");
        let provider = Box::pin(stream::iter(vec![
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_sse_custom","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":10}}}

"#
            .to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_apply_patch","name":"apply_patch"}}

"#
            .to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"input\":\"*** Begin Patch\\n*** End Patch\"}"}}

"#
            .to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#
            .to_vec()),
            Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}

"#
            .to_vec()),
            Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#
            .to_vec()),
        ]));

        let response =
            build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
                V3HubProviderWireProtocol::Anthropic,
                provider,
                &observation,
                &context,
            )
            .await
            .expect("Anthropic SSE projection must use request context");

        assert_eq!(response["metadata"]["trace_id"], "sse-context-kept");
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["call_id"], "call_apply_patch");
        assert_eq!(response["output"][0]["name"], "apply_patch");
        assert_eq!(
            response["output"][0]["input"],
            "*** Begin Patch\n*** End Patch"
        );
    }

    #[tokio::test]
    async fn anthropic_provider_sse_duplicate_message_start_before_content_merges_metadata() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_dup","type":"message","role":"assistant","content":[],"model":"claude-fable-5","usage":{"input_tokens":7}}}

"#
            .to_vec()),
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"model":"claude-fable-5","id":"msg_dup","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"cache_read_input_tokens":5,"output_tokens":0,"service_tier":"standard"}}}

"#
            .to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#
            .to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"duplicate start tolerated"}}

"#
            .to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#
            .to_vec()),
            Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}

"#
            .to_vec()),
            Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#
            .to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .expect("compatible duplicate message_start must be provider codec compatible");

        assert_eq!(response["id"], "msg_dup");
        assert_eq!(response["model"], "claude-fable-5");
        assert_eq!(response["status"], "completed");
        assert_eq!(response["finish_reason"], "end_turn");
        assert_eq!(
            response["output"][0]["content"][0]["text"],
            "duplicate start tolerated"
        );
        assert_eq!(response["usage"]["input_tokens"], 7);
        assert_eq!(response["usage"]["output_tokens"], 3);
        assert_eq!(response["usage"]["total_tokens"], 10);
        assert_eq!(response["usage"]["cache_read_input_tokens"], 5);
    }

    #[tokio::test]
    async fn anthropic_provider_sse_duplicate_message_start_eof_without_stop_still_fails() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_dup_eof","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":7}}}

"#
            .to_vec()),
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"model":"claude-fable-5","id":"msg_dup_eof","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"output_tokens":0}}}

"#
            .to_vec()),
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
        assert!(!error.to_string().contains("duplicate message_start"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_duplicate_message_start_different_id_fails() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_one\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_two\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
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
            .contains("duplicate message_start with different id"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_duplicate_message_start_after_content_start_fails() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_after_content\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_after_content\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
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
            .contains("duplicate message_start after content_block_start"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_message_stop_closes_open_thinking_block_without_502() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_glmrelay\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"glm-5.2\",\"content\":[],\"usage\":{\"input_tokens\":210584,\"output_tokens\":0}}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Working on it\"}}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":205404,\"cache_read_input_tokens\":203776,\"output_tokens\":28},\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .expect(
            "terminal Anthropic message_stop must preserve completed thinking instead of raising synthetic 502",
        );

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["type"], "reasoning");
        assert_eq!(response["output"][0]["summary"][0]["text"], "Working on it");
        let snapshot = observation.snapshot().expect("stream observation");
        assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
        assert_eq!(snapshot.finish_reason.as_deref(), Some("end_turn"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_rejects_thinking_text_alias() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_alias\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"text\":\"alias text\"}}\n\n".to_vec()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
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
            .contains("Anthropic codec malformed reasoning content"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_rejects_thinking_delta_text_alias() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_delta_alias\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"text\":\"alias text\"}}\n\n".to_vec()),
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
            .contains("Anthropic codec malformed reasoning content"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_rejects_redacted_signature_alias() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_redacted_alias\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"signature\":\"alias data\"}}\n\n".to_vec()),
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
            .contains("Anthropic codec malformed reasoning content"));
    }

    #[tokio::test]
    async fn anthropic_provider_sse_rejects_native_and_alias_dual_truth() {
        for content_block in [
            r#"{"type":"thinking","thinking":"native","text":"alias"}"#,
            r#"{"type":"redacted_thinking","data":"native","signature":"alias"}"#,
        ] {
            let observation = V3RuntimeStreamObservation::default();
            let stream = format!(
                "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_dual\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}}}\n\nevent: content_block_start\ndata: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{content_block}}}\n\n"
            );
            let provider = Box::pin(stream::iter(vec![Ok(stream.into_bytes())]));
            let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
                V3HubProviderWireProtocol::Anthropic,
                provider,
                &observation,
            )
            .await
            .unwrap_err();

            assert!(error
                .to_string()
                .contains("Anthropic codec malformed reasoning content"));
        }
    }

    #[tokio::test]
    async fn anthropic_provider_sse_message_stop_does_not_close_open_tool_block() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_tool_missing_stop\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"glm-5.2\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"exec_command\",\"input\":{}}}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
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
            .contains("content block 0 ended without content_block_stop"));
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
    async fn responses_provider_sse_materializes_created_tool_usage_without_silent_loss() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_scaffold\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"exec_command\",\"arguments\":\"\"}}\n\n".to_vec()),
            Ok(b"event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"call_1\",\"delta\":\"{\\\"cmd\\\":\"}\n\n".to_vec()),
            Ok(b"event: response.function_call_arguments.done\ndata: {\"type\":\"response.function_call_arguments.done\",\"call_id\":\"call_1\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"requires_action\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}},\"required_action\":{\"type\":\"submit_tool_outputs\"}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap();

        assert_eq!(response["id"], "resp_scaffold");
        assert_eq!(response["model"], "provider-model");
        assert_eq!(response["created_at"], 123);
        assert_eq!(response["status"], "requires_action");
        assert_eq!(response["required_action"]["type"], "submit_tool_outputs");
        assert_eq!(response["usage"]["total_tokens"], 5);
        assert_eq!(response["output"][0]["call_id"], "call_1");
        assert_eq!(response["output"][0]["arguments"], "{\"cmd\":\"pwd\"}");
    }

    #[tokio::test]
    async fn responses_provider_sse_reasoning_summary_events_materialize_without_provider_failure()
    {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_reasoning_summary\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_part.added\ndata: {\"type\":\"response.reasoning_summary_part.added\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"part\":{\"type\":\"summary_text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"Need \"}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"inspect\"}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_text.done\ndata: {\"type\":\"response.reasoning_summary_text.done\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"text\":\"Need inspect\"}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_part.done\ndata: {\"type\":\"response.reasoning_summary_part.done\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"part\":{\"type\":\"summary_text\",\"text\":\"Need inspect\"}}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap();

        assert_eq!(response["id"], "resp_reasoning_summary");
        assert_eq!(response["status"], "completed");
        assert_eq!(response["usage"]["total_tokens"], 5);
        assert_eq!(response["output"][0]["id"], "rs_1");
        assert_eq!(response["output"][0]["type"], "reasoning");
        assert_eq!(
            response["output"][0]["summary"][0],
            json!({"type":"summary_text","text":"Need inspect"})
        );
    }

    #[tokio::test]
    async fn responses_provider_sse_custom_tool_call_input_events_materialize_without_provider_failure(
    ) {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_custom_tool_call_input\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"custom_tool_call\",\"call_id\":\"call_ctc\",\"name\":\"exec_command\",\"input\":\"\"}}\n\n".to_vec()),
            Ok(b"event: response.custom_tool_call_input.delta\ndata: {\"type\":\"response.custom_tool_call_input.delta\",\"output_index\":0,\"item_id\":\"ctc_1\",\"delta\":\"{\\\"cmd\\\":\\\"\"}\n\n".to_vec()),
            Ok(b"event: response.custom_tool_call_input.delta\ndata: {\"type\":\"response.custom_tool_call_input.delta\",\"output_index\":0,\"item_id\":\"ctc_1\",\"delta\":\"pwd\\\"}\"}\n\n".to_vec()),
            Ok(b"event: response.custom_tool_call_input.done\ndata: {\"type\":\"response.custom_tool_call_input.done\",\"output_index\":0,\"item_id\":\"ctc_1\",\"input\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap();

        assert_eq!(response["id"], "resp_custom_tool_call_input");
        assert_eq!(response["status"], "completed");
        assert_eq!(response["usage"]["total_tokens"], 5);
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["call_id"], "call_ctc");
        assert_eq!(response["output"][0]["input"], "{\"cmd\":\"pwd\"}");
    }

    #[tokio::test]
    async fn responses_provider_sse_merges_stream_output_items_into_terminal_output_without_silent_loss(
    ) {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_tool_search_merge\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Searching\"}]}}\n\n".to_vec()),
            Ok(b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"id\":\"tsc_1\",\"type\":\"tool_search_call\",\"call_id\":\"call_search\",\"execution\":\"client\",\"status\":\"completed\",\"arguments\":{\"query\":\"computer use control local Mac apps screenshot click type\",\"limit\":5}}}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tool_search_merge\",\"status\":\"completed\",\"output\":[{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Searching\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":214,\"total_tokens\":216}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap();

        assert_eq!(response["status"], "completed");
        assert_eq!(response["usage"]["output_tokens"], 214);
        assert_eq!(response["output"].as_array().unwrap().len(), 2);
        assert_eq!(response["output"][0]["type"], "reasoning");
        assert_eq!(response["output"][1]["type"], "tool_search_call");
        assert_eq!(response["output"][1]["call_id"], "call_search");
        assert_eq!(
            response["output"][1]["arguments"]["query"],
            "computer use control local Mac apps screenshot click type"
        );
    }

    #[tokio::test]
    async fn responses_provider_sse_stream_output_without_identity_does_not_overwrite_terminal_output(
    ) {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_no_identity_merge\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"stream text\"}]}}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_no_identity_merge\",\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"terminal reasoning\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":4,\"total_tokens\":6}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap();

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"].as_array().unwrap().len(), 2);
        assert_eq!(response["output"][0]["type"], "message");
        assert_eq!(response["output"][1]["type"], "reasoning");
        assert_eq!(
            response["output"][1]["summary"][0]["text"],
            "terminal reasoning"
        );
    }

    #[tokio::test]
    async fn responses_provider_sse_unknown_response_event_fails_instead_of_discarding() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.reasoning_summary.delta\ndata: {\"type\":\"response.reasoning_summary.delta\",\"delta\":\"lost\"}\n\n".to_vec(),
        )]));
        let error = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("response.reasoning_summary.delta is unsupported"));
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

    #[test]
    fn web_search_state_machine_advances_to_search_result_captured_via_hop() {
        // 搜索 hop 的状态迁移契约：ToolCallObserved -> SearchResultCaptured
        // 携带归一化结果；非相邻迁移必须被拒绝。
        let observed = V3WebSearchCenterState::new()
            .transition_to(
                V3WebSearchCenterPhase::LocalToolSurfaceActive,
                "req04_web_search_surface_active",
            )
            .expect("idle -> local_tool_surface_active")
            .with_original_call_id(Some("call_ws_1"))
            .with_query(Some("routecodex v3"))
            .transition_to(
                V3WebSearchCenterPhase::ToolCallObserved,
                "resp03_websearch_call_observed",
            )
            .expect("local_tool_surface_active -> tool_call_observed");
        let prepared = observed
            .transition_to(
                V3WebSearchCenterPhase::SearchDispatchPrepared,
                "search_hop_dispatch_prepared",
            )
            .expect("tool_call_observed -> search_dispatch_prepared");
        let in_flight = prepared
            .transition_to(
                V3WebSearchCenterPhase::SearchInFlight,
                "search_hop_in_flight",
            )
            .expect("search_dispatch_prepared -> search_in_flight");
        let captured = in_flight
            .transition_to(
                V3WebSearchCenterPhase::SearchResultCaptured,
                "search_hop_result_captured",
            )
            .expect("search_in_flight -> search_result_captured");
        assert_eq!(
            captured.phase(),
            V3WebSearchCenterPhase::SearchResultCaptured
        );
        assert_eq!(captured.original_call_id(), Some("call_ws_1"));
        assert_eq!(captured.query(), Some("routecodex v3"));
        // 非法迁移：SearchResultCaptured -> SearchInFlight 必须拒绝
        let error = captured
            .transition_to(V3WebSearchCenterPhase::SearchInFlight, "backwards")
            .expect_err("terminal captured must not move backwards");
        assert!(error.contains("invalid web_search ServerTool transition"));
    }
}
