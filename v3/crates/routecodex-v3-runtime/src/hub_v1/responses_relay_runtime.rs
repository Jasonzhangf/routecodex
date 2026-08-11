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

#[path = "responses_relay_diagnostics.rs"]
mod responses_relay_diagnostics;
#[path = "responses_openai_chat_conversion.rs"]
mod responses_openai_chat_conversion;
#[path = "responses_relay_failures.rs"]
mod responses_relay_failures;
#[path = "responses_relay_stopless.rs"]
mod responses_relay_stopless;
#[path = "responses_relay_dry_run.rs"]
mod responses_relay_dry_run;
#[path = "responses_relay_json_hooks.rs"]
mod responses_relay_json_hooks;
use responses_openai_chat_conversion::*;
use responses_relay_dry_run::*;
use responses_relay_json_hooks::*;
pub use responses_relay_dry_run::{
    execute_v3_responses_relay_dry_run_orchestration_outcome_with_local_continuation_and_stopless_control,
    project_v3_responses_relay_runtime_failure,
};
use responses_relay_failures::{
    allowed_execution_modes_for_relay_server, error_output,
    is_v3_responses_provider_response_failure, provider_failure_output, provider_http_failure,
    provider_response_hook_failure, provider_response_stream_failure,
    provider_response_stream_relay_failure, provider_request_relay_failure,
    provider_runtime_failure, provider_semantic_failure, server_routing_group,
};
use responses_relay_stopless::*;

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
        let transport_result = match tokio::time::timeout(
            V3_RELAY_TRANSPORT_RESPONSE_TIMEOUT,
            transport.send(transport_request),
        )
        .await
        {
            Err(_) => Err(V3ProviderError::Transport {
                request_id: input.request_id.clone(),
                provider_id: selected_target_provider_id.clone(),
                reason: "provider transport did not return response headers within timeout"
                    .to_string(),
            }),
            Ok(result) => result,
        };
        let provider_raw = match transport_result {
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
                        responses_relay_diagnostics::anthropic_cyber_refusal_error_from_payload(
                            &provider_value,
                        )
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
                    if let Some(semantic_error) =
                        responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
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
                let request_web_search_state = match request_web_search_state.clone() {
                    Some(state) => Some(state),
                    None => match stopless_control.as_ref() {
                        Some(execution) => execution
                            .control
                            .web_search_load_for_scope(&execution.scope)?,
                        None => None,
                    },
                };
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
                        web_search_center_state: request_web_search_state,
                        stopless_state: stopless_state.as_ref(),
                        stopless_control_has_client_session_scope,
                        transition_request_id: &transition_request_id,
                        transition_updated_at,
                        retain_response_cipher: is_v3_retain_response_cipher(
                            selected.route.target_plan.len(),
                            &selected.candidate.model_id,
                        ),
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
                                .web_search_store_for_scope(
                                    &execution.scope,
                                    captured,
                                    V3ServerToolCenterWriteOrigin {
                                        module: "responses_relay_runtime",
                                        symbol: "commit_or_release_responses_local_continuation",
                                        stage: "resp03_commit_effects",
                                    },
                                    Some("resp03 commit effects persist captured web_search state"),
                                    None,
                                )?;
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
                        crate::hub_v1::relay_runtime_core::guard_v3_provider_sse_idle(
                            &input.request_id,
                            &selected_target_provider_id,
                            stream,
                            crate::hub_v1::relay_runtime_core::V3_RELAY_SSE_STREAM_IDLE_TIMEOUT,
                        ),
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
                    if let Some(semantic_error) =
                        responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
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
                        retain_response_cipher: is_v3_retain_response_cipher(
                            selected.route.target_plan.len(),
                            &selected.candidate.model_id,
                        ),
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
                                .web_search_store_for_scope(
                                    &execution.scope,
                                    captured,
                                    V3ServerToolCenterWriteOrigin {
                                        module: "responses_relay_runtime",
                                        symbol: "commit_or_release_responses_local_continuation",
                                        stage: "resp03_commit_effects",
                                    },
                                    Some("resp03 commit effects persist captured web_search state"),
                                    None,
                                )?;
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



#[cfg(test)]
#[path = "responses_relay_runtime_tests.rs"]
mod responses_relay_runtime_tests;
#[cfg(test)]
#[path = "responses_relay_runtime_tests_extra.rs"]
mod responses_relay_runtime_tests_extra;
