use crate::hooks::{build_v3_provider_error_source, V3HookRegistry};
use crate::hub_v1::{
    apply_v3_responses_direct_stopless_request_hook, apply_v3_stop_servertool_hook_at_resp03,
    apply_v3_stopless_request_hook_at_req04, apply_v3_tool_call_servertool_hook_at_resp03,
    build_provider_resp_compat_02_from_v3_provider_resp_inbound_01,
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02,
    build_v3_provider_resp_inbound_01_raw_with_compat_profile,
    v3_responses_direct_stopless_center_enabled_for_server, V3HubContinuationOwnership,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRelayRequestHookEvent, V3HubRelayResponseHookProfile, V3HubTransportIntent,
    V3ProviderRespInbound01RawContext, V3RuntimeObservability, V3RuntimeProviderFailureEventSink,
    V3RuntimeProviderFailureObservation, V3RuntimeRouteSelectionEventSink,
    V3RuntimeStreamObservation, V3StoplessCenterState,
};
use crate::nodes::*;
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    v3_relay_provider_policy_now_epoch_ms, V3ProviderFailureRuntimeHealth,
    V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET,
};
use crate::runtime_timing::V3RuntimeTimingState;
use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime, V3DryRunFixture};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_06_client_projected_from_v3_error_05, V3Error01SourceRaised,
    V3Error05ExecutionAction, V3Error05ExecutionDecision, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderAvailabilityProjection,
    V3ProviderAvailabilityReader, V3ProviderError, V3ProviderFailureRecord, V3ProviderResp14Raw,
    V3ProviderResponseBodyKind, V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use crate::remote_continuation::{
    V3RemoteContinuationCommitInput, V3RemoteContinuationLocator, V3RemoteContinuationPin,
    V3RemoteContinuationScopeKey, V3RemoteContinuationStore,
};
use crate::shared::{V3RemoteContinuationObservation, V3SseRemoteContinuationObservationState};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, build_v3_sse_transport_in_02_from_fields,
    build_v3_sse_transport_in_03_from_v3_sse_transport_in_02,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03, SseField, SseIncrementalDecoder,
    SseTransportLimits,
};

mod direct_sse_provider_outcome;
use direct_sse_provider_outcome::{
    wrap_direct_sse_provider_outcome_stream, V3DirectSseProviderOutcome,
};

const REMOTE_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;

static DEFAULT_RESPONSES_TRANSPORT: OnceLock<ReqwestResponsesTransport> = OnceLock::new();

fn default_responses_transport() -> &'static ReqwestResponsesTransport {
    DEFAULT_RESPONSES_TRANSPORT.get_or_init(ReqwestResponsesTransport::default)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesDirectContinuationScope {
    key: V3RemoteContinuationScopeKey,
}

impl V3ResponsesDirectContinuationScope {
    pub fn responses(
        endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            key: V3RemoteContinuationScopeKey::responses(
                endpoint,
                session_id,
                conversation_id,
                port,
                routing_group,
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesDirectStoplessControlScope {
    key: V3RemoteContinuationScopeKey,
}

impl V3ResponsesDirectStoplessControlScope {
    pub fn responses(
        endpoint: impl Into<String>,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        port: u16,
        routing_group: impl Into<String>,
    ) -> Self {
        Self {
            key: V3RemoteContinuationScopeKey::responses(
                endpoint,
                session_id,
                conversation_id,
                port,
                routing_group,
            ),
        }
    }

    fn has_client_session_scope(&self) -> bool {
        let session_id = self.key.session_id.trim();
        let conversation_id = self.key.conversation_id.trim();
        if session_id.is_empty() || conversation_id.is_empty() {
            return false;
        }
        !(session_id == conversation_id && session_id.starts_with("request:"))
    }
}

impl From<&V3ResponsesDirectContinuationScope> for V3ResponsesDirectStoplessControlScope {
    fn from(scope: &V3ResponsesDirectContinuationScope) -> Self {
        Self {
            key: scope.key.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ResponsesDirectStoplessControlKey {
    key: V3RemoteContinuationScopeKey,
}

impl From<&V3ResponsesDirectStoplessControlScope> for V3ResponsesDirectStoplessControlKey {
    fn from(scope: &V3ResponsesDirectStoplessControlScope) -> Self {
        Self {
            key: scope.key.clone(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ResponsesDirectStoplessControlState {
    store: Arc<Mutex<BTreeMap<V3ResponsesDirectStoplessControlKey, V3StoplessCenterState>>>,
}

impl V3ResponsesDirectStoplessControlState {
    pub fn load_for_scope(
        &self,
        scope: &V3ResponsesDirectStoplessControlScope,
    ) -> Result<Option<V3StoplessCenterState>, String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())
            .map(|store| {
                store
                    .get(&V3ResponsesDirectStoplessControlKey::from(scope))
                    .cloned()
            })
    }

    pub fn store_for_scope(
        &self,
        scope: &V3ResponsesDirectStoplessControlScope,
        state: V3StoplessCenterState,
    ) -> Result<(), String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())?
            .insert(V3ResponsesDirectStoplessControlKey::from(scope), state);
        Ok(())
    }

    pub fn clear_for_scope(
        &self,
        scope: &V3ResponsesDirectStoplessControlScope,
    ) -> Result<(), String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&V3ResponsesDirectStoplessControlKey::from(scope));
        Ok(())
    }

    pub fn len(&self) -> Result<usize, String> {
        self.store
            .lock()
            .map(|store| store.len())
            .map_err(|error| error.to_string())
    }

    pub fn is_empty(&self) -> Result<bool, String> {
        self.len().map(|len| len == 0)
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ResponsesDirectContinuationState {
    store: Arc<Mutex<V3RemoteContinuationStore>>,
}

impl V3ResponsesDirectContinuationState {
    pub fn contains(&self, response_id: &str) -> Result<bool, String> {
        self.store
            .lock()
            .map(|store| store.contains(response_id))
            .map_err(|error| error.to_string())
    }

    pub fn contains_for_req03(
        &self,
        response_id: &str,
        scope: &V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Result<bool, String> {
        self.store
            .lock()
            .map_err(|error| error.to_string())
            .and_then(
                |store| match store.load_for_req03(response_id, &scope.key, now_epoch_ms) {
                    Ok(_) => Ok(true),
                    Err(
                        crate::remote_continuation::V3RemoteContinuationError::NotFound { .. }
                        | crate::remote_continuation::V3RemoteContinuationError::ScopeMismatch {
                            ..
                        }
                        | crate::remote_continuation::V3RemoteContinuationError::Expired { .. },
                    ) => Ok(false),
                    Err(error) => Err(error.to_string()),
                },
            )
    }

    #[cfg(test)]
    pub(crate) fn commit_for_req03_test(
        &self,
        response_id: &str,
        scope: &V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Result<(), String> {
        let locator = V3RemoteContinuationLocator::new_direct(
            response_id,
            scope.key.clone(),
            V3RemoteContinuationPin::new("direct-provider", "gpt-5.5", "key"),
            "test-capability-revision",
            now_epoch_ms,
            now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
        );
        self.store
            .lock()
            .map_err(|error| error.to_string())?
            .commit(V3RemoteContinuationCommitInput::locator_only(locator))
            .map_err(|error| error.to_string())
    }

    pub fn len(&self) -> Result<usize, String> {
        self.store
            .lock()
            .map(|store| store.len())
            .map_err(|error| error.to_string())
    }

    pub fn is_empty(&self) -> Result<bool, String> {
        self.len().map(|len| len == 0)
    }
}

pub struct V3ResponsesDirectRuntimeSharedState<'a> {
    pub continuation_state: &'a V3ResponsesDirectContinuationState,
    pub stopless_control: &'a V3ResponsesDirectStoplessControlState,
    provider_health: V3ProviderFailureRuntimeHealth,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
}

impl<'a> V3ResponsesDirectRuntimeSharedState<'a> {
    pub fn new<H>(
        continuation_state: &'a V3ResponsesDirectContinuationState,
        stopless_control: &'a V3ResponsesDirectStoplessControlState,
        provider_health: H,
    ) -> Self
    where
        H: Into<V3ProviderFailureRuntimeHealth>,
    {
        Self {
            continuation_state,
            stopless_control,
            provider_health: provider_health.into(),
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    pub fn with_provider_failure_event_sink(
        mut self,
        sink: Option<V3RuntimeProviderFailureEventSink>,
    ) -> Self {
        self.provider_failure_event_sink = sink;
        self
    }

    pub fn with_route_selection_event_sink(
        mut self,
        sink: Option<V3RuntimeRouteSelectionEventSink>,
    ) -> Self {
        self.route_selection_event_sink = sink;
        self
    }
}

#[derive(Clone)]
struct V3ResponsesDirectRuntimeCoreState<'a> {
    continuation_state: Option<&'a V3ResponsesDirectContinuationState>,
    continuation_scope: Option<V3ResponsesDirectContinuationScope>,
    stopless_control: Option<&'a V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<V3ResponsesDirectStoplessControlScope>,
    now_epoch_ms: u64,
    provider_health: Option<V3ProviderFailureRuntimeHealth>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    // Candidate set from the Server-side protocol plan; always set together
    // with initial_selected_target so in-Target reselection keeps working
    // when routing was preplanned.
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    // Node trace the protocol plan already executed for this request; the
    // kernel splices it in instead of re-running Router05..Target09.
    initial_plan_trace: Option<Vec<&'static str>>,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
}

impl<'a> V3ResponsesDirectRuntimeCoreState<'a> {
    fn no_continuation() -> Self {
        Self {
            continuation_state: None,
            continuation_scope: None,
            stopless_control: None,
            stopless_scope: None,
            now_epoch_ms: 0,
            provider_health: None,
            initial_selected_target: None,
            initial_expanded: None,
            initial_plan_trace: None,
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    fn with_continuation(
        state: &'a V3ResponsesDirectContinuationState,
        scope: V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Self {
        Self {
            continuation_state: Some(state),
            continuation_scope: Some(scope),
            stopless_control: None,
            stopless_scope: None,
            now_epoch_ms,
            provider_health: None,
            initial_selected_target: None,
            initial_expanded: None,
            initial_plan_trace: None,
            provider_failure_event_sink: None,
            route_selection_event_sink: None,
        }
    }

    fn with_stopless_control(
        mut self,
        stopless_control: &'a V3ResponsesDirectStoplessControlState,
        stopless_scope: V3ResponsesDirectStoplessControlScope,
    ) -> Self {
        self.stopless_control = Some(stopless_control);
        self.stopless_scope = Some(stopless_scope);
        self
    }

    fn with_provider_health(mut self, provider_health: V3ProviderFailureRuntimeHealth) -> Self {
        self.provider_health = Some(provider_health);
        self
    }

    fn with_provider_failure_event_sink(
        mut self,
        sink: Option<V3RuntimeProviderFailureEventSink>,
    ) -> Self {
        self.provider_failure_event_sink = sink;
        self
    }

    fn with_route_selection_event_sink(
        mut self,
        sink: Option<V3RuntimeRouteSelectionEventSink>,
    ) -> Self {
        self.route_selection_event_sink = sink;
        self
    }

    fn with_initial_plan(mut self, plan: &V3ResponsesProtocolExecutionPlan) -> Self {
        self.initial_selected_target = Some(plan.decision.target.clone());
        self.initial_expanded = Some(plan.expanded.clone());
        self.initial_plan_trace = Some(plan.routing_trace_segment());
        self
    }
}

#[derive(Debug)]
pub struct V3ResponsesDirectRuntimeOutput {
    pub client_payload: V3Resp15ClientPayload,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
    pub observability: Option<V3RuntimeObservability>,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
    pub protocol_relay_handoff: Option<V3ResponsesProtocolRelayHandoff>,
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolRelayHandoff {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub node_trace: Vec<&'static str>,
    pub provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolExecutionPlan {
    pub decision: V3Execution11ProtocolDecision,
    pub node_trace: Vec<&'static str>,
    // Candidate set expanded at Target09 during planning; carried so the
    // kernel can reselect inside the Target on provider failure without
    // re-entering the Router (Router re-entry after Target10 is forbidden).
    pub expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
}

impl V3ResponsesProtocolExecutionPlan {
    // Routing nodes the plan already executed between Req04 and Target10.
    // The kernel splices these into its trace when starting from this plan so
    // the client-visible node trace stays identical to the unplanned path.
    fn routing_trace_segment(&self) -> Vec<&'static str> {
        self.node_trace
            .iter()
            .skip_while(|node| **node != "V3Req04StandardizedResponses")
            .skip(1)
            .take_while(|node| **node != "V3Target10ConcreteProviderSelected")
            .copied()
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct V3ResponsesProtocolExecutionPlanFailure {
    pub source: V3Error01SourceRaised,
    pub node_trace: Vec<&'static str>,
}

pub fn project_v3_protocol_execution_plan_failure(
    failure: V3ResponsesProtocolExecutionPlanFailure,
) -> V3Error06ClientProjected {
    V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source: failure.source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: None,
    })
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation(
    state: &V3ResponsesDirectContinuationState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    continuation_scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            state,
            continuation_scope,
            now_epoch_ms,
        )
        .with_stopless_control(&stopless_control, stopless_scope),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
    shared_state: V3ResponsesDirectRuntimeSharedState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    continuation_scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            shared_state.continuation_state,
            continuation_scope,
            now_epoch_ms,
        )
        .with_stopless_control(shared_state.stopless_control, stopless_scope)
        .with_provider_health(shared_state.provider_health)
        .with_provider_failure_event_sink(shared_state.provider_failure_event_sink.clone())
        .with_route_selection_event_sink(shared_state.route_selection_event_sink.clone()),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target(
    shared_state: V3ResponsesDirectRuntimeSharedState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    continuation_scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
    now_epoch_ms: u64,
    initial_plan: &V3ResponsesProtocolExecutionPlan,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            shared_state.continuation_state,
            continuation_scope,
            now_epoch_ms,
        )
        .with_stopless_control(shared_state.stopless_control, stopless_scope)
        .with_provider_health(shared_state.provider_health)
        .with_provider_failure_event_sink(shared_state.provider_failure_event_sink.clone())
        .with_route_selection_event_sink(shared_state.route_selection_event_sink.clone())
        .with_initial_plan(initial_plan),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}

pub fn plan_v3_responses_protocol_execution_with_provider_health(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    provider_health: impl Into<V3ProviderFailureRuntimeHealth>,
    now_epoch_ms: u64,
) -> Result<V3ResponsesProtocolExecutionPlan, V3ResponsesProtocolExecutionPlanFailure> {
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    let standardized = build_v3_req_04_standardized_responses_from_v3_server_03(raw);
    trace.push("V3Req04StandardizedResponses");
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&standardized.body) {
        return Err(protocol_plan_failure(
            runtime_source(
                "V3Req04StandardizedResponses",
                format!("RouteCodex side-channel field {key} cannot enter request payload"),
            ),
            trace,
        ));
    }
    if standardized
        .body
        .get("previous_response_id")
        .and_then(Value::as_str)
        .is_some()
    {
        return Err(protocol_plan_failure(
            runtime_source(
                "V3HubReqContinuation03Classified",
                "protocol execution plan only handles non-continuation responses requests",
            ),
            trace,
        ));
    }
    let allowed_modes = match manifest
        .servers
        .get(&standardized.protocol_context.server_id)
        .and_then(|server| server.execution.as_ref())
    {
        Some(execution) => execution.allowed_modes.clone(),
        None => {
            return Err(protocol_plan_failure(
                runtime_source(
                    "V3Execution11ProtocolDecision",
                    format!(
                        "server {} lacks execution allowed_modes",
                        standardized.protocol_context.server_id
                    ),
                ),
                trace,
            ))
        }
    };
    let target = V3TargetInterpreter::default();
    let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized, manifest);
    let router = V3VirtualRouter::process_shared();
    let classified = match router.classify_request_with_facts(
        manifest,
        &standardized.protocol_context.server_id,
        &standardized.protocol_context.endpoint,
        routing_facts,
    ) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Router05RequestClassified", error),
                trace,
            ))
        }
    };
    trace.push("V3Router05RequestClassified");
    let plan = match router.resolve_route_pool_plan(manifest, classified) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Router06RoutePoolResolved", error),
                trace,
            ))
        }
    };
    trace.push("V3Router06RoutePoolResolved");
    let hit = match router.hit_opaque_target_plan_once(plan, 0) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Router07OpaqueTargetHitOnce", error),
                trace,
            ))
        }
    };
    trace.push("V3Router07OpaqueTargetHitOnce");
    let kind = target.classify_kind(hit);
    trace.push("V3Target08KindClassified");
    let expanded = match target.expand_candidates(manifest, kind, 0) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                runtime_source("V3Target09CandidateSetExpanded", error),
                trace,
            ))
        }
    };
    trace.push("V3Target09CandidateSetExpanded");
    let provider_health = provider_health.into();
    let selected = match target.select_available(expanded.clone(), &provider_health, now_epoch_ms) {
        Ok(value) => value,
        Err(error) => {
            return Err(protocol_plan_failure(
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::TargetPoolExhausted,
                    "V3Target10ConcreteProviderSelected",
                    "selected_target_exhausted",
                    format!(
                        "{} candidates unavailable",
                        error.attempted_candidates.len()
                    ),
                ),
                trace,
            ))
        }
    };
    trace.push("V3Target10ConcreteProviderSelected");
    let decision = match build_v3_execution_11_protocol_decision_from_v3_target_10(
        selected,
        "responses",
        &allowed_modes,
    ) {
        Ok(decision) => decision,
        Err(source) => {
            trace.push("V3Execution11ProtocolDecision");
            return Err(protocol_plan_failure(source, trace));
        }
    };
    trace.push("V3Execution11ProtocolDecision");
    Ok(V3ResponsesProtocolExecutionPlan {
        decision,
        node_trace: trace,
        expanded,
    })
}

fn protocol_plan_failure(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
) -> V3ResponsesProtocolExecutionPlanFailure {
    V3ResponsesProtocolExecutionPlanFailure { source, node_trace }
}

async fn execute_v3_responses_direct_runtime_kernel_with_transport_debug_core<
    T: ResponsesTransport,
>(
    state: V3ResponsesDirectRuntimeCoreState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
    debug: &V3DebugRuntime,
) -> V3ResponsesDirectRuntimeOutput {
    let scope = match debug.start_trace(&raw.server_id, &raw.request_id, &raw.execution_id) {
        Ok(scope) => scope,
        Err(error) => {
            return debug_error_output("V3Debug01TraceContextStarted", error, &hook_registry)
        }
    };
    if let Err(error) = debug.capture_raw_request(&scope, raw.body.clone()) {
        return debug_error_output("V3Debug02RawRequestCaptured", error, &hook_registry);
    }

    let output = execute_v3_responses_direct_runtime_kernel_core(
        state,
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await;

    for node_id in &output.node_trace {
        if let Err(error) = debug.record_node_event(
            &scope,
            *node_id,
            "executed",
            output
                .error_chain
                .as_ref()
                .map(|chain| json!({"error_chain": chain})),
        ) {
            return debug_error_output("V3Debug01NodeEventRegistered", error, &hook_registry);
        }
    }
    if let Err(error) =
        debug.capture_raw_response(&scope, client_payload_debug_value(&output.client_payload))
    {
        return debug_error_output("V3Debug03RawResponseCaptured", error, &hook_registry);
    }
    output
}

#[derive(Debug)]
struct V3DryRunNoNetworkTransport {
    response_payload: Value,
    captured_provider_request: Arc<Mutex<Option<Value>>>,
}

#[async_trait]
impl ResponsesTransport for V3DryRunNoNetworkTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        if let Ok(mut captured) = self.captured_provider_request.lock() {
            *captured = Some(request.redacted_provider_request_projection());
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
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
        ))
    }
}

pub async fn execute_v3_responses_direct_dry_run_runtime(
    fixture: V3DryRunFixture,
    manifest: &V3Config05ManifestPublished,
    debug: &V3DebugRuntime,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_direct_dry_run_runtime_inner(fixture, manifest, debug, None).await
}

pub async fn execute_v3_responses_direct_dry_run_runtime_with_initial_target(
    fixture: V3DryRunFixture,
    manifest: &V3Config05ManifestPublished,
    debug: &V3DebugRuntime,
    initial_plan: &V3ResponsesProtocolExecutionPlan,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_direct_dry_run_runtime_inner(fixture, manifest, debug, Some(initial_plan))
        .await
}

async fn execute_v3_responses_direct_dry_run_runtime_inner(
    fixture: V3DryRunFixture,
    manifest: &V3Config05ManifestPublished,
    debug: &V3DebugRuntime,
    initial_plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> crate::V3FoundationRuntimeOutput {
    if let Err(error) = debug.register_dry_run_fixture(fixture.clone()) {
        return crate::project_v3_debug_failure("V3DryRunFixtureRegistered", error);
    }
    if let Err(error) = debug.build_dry_run_execution_plan(&fixture.fixture_id) {
        return crate::project_v3_debug_failure("V3DryRunExecutionPlanned", error);
    }
    let request_id = format!("dry-run-{}", fixture.fixture_id);
    let execution_id = format!("dry-run-exec-{}", fixture.fixture_id);
    let scope = match debug.start_trace(&fixture.server_id, &request_id, &execution_id) {
        Ok(scope) => scope,
        Err(error) => {
            return crate::project_v3_debug_failure("V3Debug01TraceContextStarted", error)
        }
    };
    let session_id = match debug.start_snapshot_session(&scope, "dry-run") {
        Ok(session_id) => session_id,
        Err(error) => return crate::project_v3_debug_failure("V3SnapshotSessionStarted", error),
    };
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3DryRunNoNetworkTransport {
        response_payload: fixture.response_payload.clone(),
        captured_provider_request: Arc::clone(&captured_provider_request),
    };
    let core_state = match initial_plan {
        Some(plan) => V3ResponsesDirectRuntimeCoreState::no_continuation().with_initial_plan(plan),
        None => V3ResponsesDirectRuntimeCoreState::no_continuation(),
    };
    let mut output = execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        core_state,
        manifest,
        V3Server03HttpRequestRaw {
            server_id: fixture.server_id.clone(),
            request_id,
            execution_id,
            method: fixture.method.clone(),
            path: fixture.path.clone(),
            body: fixture.request_payload.clone(),
        },
        crate::register_responses_direct_hooks(),
        &transport,
        debug,
    )
    .await;
    if let Some(index) = output
        .node_trace
        .iter()
        .position(|node| *node == "V3Transport13ResponsesHttpRequest")
    {
        output
            .node_trace
            .insert(index + 1, "V3DryRunNoNetworkTerminalEffect");
    }
    output.node_trace.push("V3Server16HttpFrame");
    for node_id in ["V3DryRunNoNetworkTerminalEffect", "V3Server16HttpFrame"] {
        if let Err(error) = debug.record_node_event(
            &scope,
            node_id,
            "dry_run",
            Some(json!({"terminal_effect": "no_network_send"})),
        ) {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return crate::project_v3_debug_failure("V3Debug01NodeEventRegistered", error);
        }
    }
    for node_id in &output.node_trace {
        if let Err(error) = debug.record_snapshot(
            &scope,
            &session_id,
            *node_id,
            json!({"node_id": node_id, "dry_run": true}),
        ) {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return crate::project_v3_debug_failure("V3SnapshotNodeCaptured", error);
        }
    }
    let transient_snapshots = match debug.snapshots() {
        Ok(snapshots) => snapshots
            .into_iter()
            .filter(|snapshot| snapshot.session_id == session_id)
            .collect::<Vec<_>>(),
        Err(error) => {
            let _ = debug.release_snapshot_session(&scope, &session_id);
            return crate::project_v3_debug_failure("V3SnapshotProjectionRead", error);
        }
    };
    if let Err(error) = debug.release_snapshot_session(&scope, &session_id) {
        return crate::project_v3_debug_failure("V3SnapshotSessionReleased", error);
    }
    let response_payload = match output.client_payload.body {
        V3ClientBody::Json(value) => value,
        V3ClientBody::Bytes(bytes) => json!({"body_kind": "bytes", "byte_len": bytes.len()}),
        V3ClientBody::Sse(_) => json!({"body_kind": "sse_stream"}),
    };
    let provider_request = captured_provider_request
        .lock()
        .ok()
        .and_then(|captured| captured.clone())
        .map(|request| debug.redact_projection(request))
        .unwrap_or_else(|| json!(null));
    let dry_run_status = if provider_request.is_null() {
        output.client_payload.status
    } else {
        200
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
                "fixture_id": fixture.fixture_id,
                "server_id": fixture.server_id,
                "method": fixture.method,
                "path": fixture.path,
                "terminal_effect": "no_network_send",
                "provider_pipeline_executed": true,
                "provider_network_send": false,
                "stopped_before_network_send": true,
                "stopped_before_provider_send": true,
                "provider_request": provider_request,
                "node_ids": output.node_trace,
                "snapshots": transient_snapshots,
                "response_payload": debug.redact_projection(response_payload)
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

pub async fn execute_v3_responses_direct_runtime_kernel<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation(),
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_continuation<T: ResponsesTransport>(
    state: &V3ResponsesDirectContinuationState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    transport: &T,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        state,
        &stopless_control,
        manifest,
        raw,
        scope,
        hook_registry,
        transport,
        now_epoch_ms,
    )
    .await
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control<
    T: ResponsesTransport,
>(
    state: &V3ResponsesDirectContinuationState,
    stopless_control: &V3ResponsesDirectStoplessControlState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    scope: V3ResponsesDirectContinuationScope,
    hook_registry: V3HookRegistry,
    transport: &T,
    now_epoch_ms: u64,
) -> V3ResponsesDirectRuntimeOutput {
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&scope);
    execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(state, scope, now_epoch_ms)
            .with_stopless_control(stopless_control, stopless_scope),
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await
}

async fn execute_v3_responses_direct_runtime_kernel_core<T: ResponsesTransport>(
    state: V3ResponsesDirectRuntimeCoreState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    let runtime_timing = V3RuntimeTimingState::start();
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    require_static_hooks(&hook_registry);
    let V3ResponsesDirectRuntimeCoreState {
        continuation_state,
        continuation_scope,
        stopless_control,
        stopless_scope,
        now_epoch_ms,
        provider_health,
        initial_selected_target,
        initial_expanded,
        initial_plan_trace,
        provider_failure_event_sink,
        route_selection_event_sink,
    } = state;

    let mut standardized = build_v3_req_04_standardized_responses_from_v3_server_03(raw);
    trace.push("V3Req04StandardizedResponses");
    if let Some(plan_trace) = initial_plan_trace {
        // Router05..Target09 already ran in the Server-side protocol plan;
        // splice those nodes so the client-visible trace stays identical to
        // the unplanned path without re-entering the Router.
        trace.extend(plan_trace);
    }
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&standardized.body) {
        return error_output(
            runtime_source(
                "V3Req04StandardizedResponses",
                format!("RouteCodex side-channel field {key} cannot enter request payload"),
            ),
            trace,
            &hook_registry,
        );
    }
    if let Err(error) = apply_v3_responses_direct_stopless_request_hook(&mut standardized.body) {
        return error_output(
            runtime_source("V3HubReqChatProcess04Governed", error),
            trace,
            &hook_registry,
        );
    }
    let mut direct_stopless_control_prepared = false;
    let mut direct_stopless_request_state: Option<V3StoplessCenterState> = None;
    let previous_response_id = standardized
        .body
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let pinned = match (
        &previous_response_id,
        continuation_state,
        continuation_scope.as_ref(),
    ) {
        (Some(response_id), Some(state), Some(scope)) => {
            let locator = match state.store.lock() {
                Ok(store) => store
                    .load_for_req03(response_id, &scope.key, now_epoch_ms)
                    .cloned(),
                Err(error) => {
                    return error_output(
                        runtime_source("V3HubReqContinuation03Classified", error),
                        trace,
                        &hook_registry,
                    )
                }
            };
            match locator {
                Ok(locator) => {
                    trace.push("V3HubReqContinuation03Classified");
                    Some(locator)
                }
                Err(error) => {
                    return error_output(
                        runtime_source("V3HubReqContinuation03Classified", error),
                        trace,
                        &hook_registry,
                    )
                }
            }
        }
        (Some(_), _, _) => {
            return error_output(
                runtime_source(
                    "V3HubReqContinuation03Classified",
                    "continuation state/scope missing",
                ),
                trace,
                &hook_registry,
            )
        }
        _ => None,
    };
    if previous_response_id.is_some() && initial_selected_target.is_some() {
        return error_output(
            runtime_source(
                "V3Execution11ProtocolDecision",
                "direct continuation must be resolved from Req03 owner store, not from a non-continuation preselected target",
            ),
            trace,
            &hook_registry,
        );
    }

    let target = V3TargetInterpreter::default();
    let direct_server_id = standardized.protocol_context.server_id.clone();
    let direct_routing_group = match manifest.servers.get(&direct_server_id) {
        Some(server) => server.routing_group.clone(),
        None => {
            return error_output(
                runtime_source(
                    "V3Config05ManifestPublished",
                    format!("server {direct_server_id} is missing"),
                ),
                trace,
                &hook_registry,
            )
        }
    };
    let provider_health =
        provider_health.unwrap_or_else(|| V3ProviderFailureRuntimeHealth::from_manifest(manifest));
    let availability = provider_health.clone();
    let mut pinned_selected = if let Some(locator) = pinned {
        let candidate = match target.resolve_exact_provider_model_auth(
            manifest,
            &locator.pin().provider_id,
            &locator.pin().model_id,
            &locator.pin().auth_handle_id,
        ) {
            Ok(candidate) => candidate,
            Err(error) => {
                return exact_pin_unavailable_output(
                    &provider_health,
                    &direct_server_id,
                    &direct_routing_group,
                    locator.pin(),
                    previous_response_id.as_deref(),
                    continuation_state,
                    error.to_string(),
                    trace,
                    &hook_registry,
                )
                .await
            }
        };
        let current_capability_revision = match capability_revision_for_pin(manifest, locator.pin())
        {
            Ok(revision) => revision,
            Err(error) => {
                return error_output(
                    runtime_source("V3HubReqTarget06Resolved", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        if let Err(error) = locator.validate_capability_revision(&current_capability_revision) {
            return error_output(
                runtime_source("V3HubReqTarget06Resolved", error),
                trace,
                &hook_registry,
            );
        }
        trace.push("V3HubReqTarget06Resolved");
        let routing_group_id = match continuation_scope.as_ref() {
            Some(scope) => scope.key.routing_group.clone(),
            None => {
                return error_output(
                    runtime_source(
                        "V3HubReqTarget06Resolved",
                        "continuation scope missing after Req03 classification",
                    ),
                    trace,
                    &hook_registry,
                )
            }
        };
        Some(routecodex_v3_target::V3Target10ConcreteProviderSelected {
            route: routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce {
                server_id: standardized.protocol_context.server_id.clone(),
                routing_group_id,
                pool_id: "continuation_exact_pin".to_string(),
                target_index: 0,
                target_kind: routecodex_v3_config::V3RouteTargetKind::ProviderModel,
                target_id: None,
                target_plan: Vec::new(),
                request_client_model: None,
                request_capabilities: BTreeSet::new(),
                request_input_tokens: build_v3_router_request_facts_from_v3_req_04(
                    &standardized,
                    manifest,
                )
                .input_tokens,
                hit_count: 1,
            },
            candidate,
            unavailable_candidates: Vec::new(),
            attempts: 1,
            default_floor_protected: false,
        })
    } else {
        None
    };
    let initial_selected_target_present = initial_selected_target.is_some();
    let expanded = if let Some(initial_expanded) = initial_expanded {
        // Server-side protocol plan already ran Router05..Target09; reuse its
        // candidate set for in-Target reselection instead of re-entering the
        // Router.
        Some(initial_expanded)
    } else if pinned_selected.is_none() && !initial_selected_target_present {
        let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized, manifest);
        let router = V3VirtualRouter::process_shared();
        let classified = match router.classify_request_with_facts(
            manifest,
            &standardized.protocol_context.server_id,
            &standardized.protocol_context.endpoint,
            routing_facts,
        ) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    runtime_source("V3Router05RequestClassified", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        trace.push("V3Router05RequestClassified");
        let plan = match router.resolve_route_pool_plan(manifest, classified) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    runtime_source("V3Router06RoutePoolResolved", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        trace.push("V3Router06RoutePoolResolved");
        let hit = match router.hit_opaque_target_plan_once(plan, 0) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    runtime_source("V3Router07OpaqueTargetHitOnce", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        trace.push("V3Router07OpaqueTargetHitOnce");
        let kind = target.classify_kind(hit);
        trace.push("V3Target08KindClassified");
        let expanded = match target.expand_candidates(manifest, kind, 0) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    runtime_source("V3Target09CandidateSetExpanded", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        trace.push("V3Target09CandidateSetExpanded");
        Some(expanded)
    } else {
        None
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut initial_selected_target = initial_selected_target;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut pending_provider_action_recovery = None;
    let mut continuation_provider_action_lookup = previous_response_id.is_some();
    let allowed_modes =
        direct_runtime_allowed_execution_modes(manifest, &standardized.protocol_context.server_id);
    loop {
        let attempt_availability = V3RuntimeAttemptAvailability {
            base: &availability,
            failed_candidates: &failed_candidates,
        };
        let selected = match pinned_selected.take() {
            Some(selected) => selected,
            None => match initial_selected_target.take() {
                Some(selected) => selected,
                None => match retry_selected.take() {
                    Some(selected) => selected,
                    None => match target.select_available(
                        match expanded.as_ref() {
                            Some(expanded) => expanded.clone(),
                            None => {
                                return error_output(
                                    runtime_source(
                                        "V3Target09CandidateSetExpanded",
                                        "routed candidate set missing",
                                    ),
                                    trace,
                                    &hook_registry,
                                )
                            }
                        },
                        &attempt_availability,
                        0,
                    ) {
                        Ok(value) => value,
                        Err(error) => {
                            return error_output(
                                build_v3_error_01_source_raised(
                                    V3ErrorSourceKind::TargetPoolExhausted,
                                    "V3Target10ConcreteProviderSelected",
                                    "selected_target_exhausted",
                                    format!(
                                        "{} candidates unavailable",
                                        error.attempted_candidates.len()
                                    ),
                                ),
                                trace,
                                &hook_registry,
                            )
                        }
                    },
                },
            },
        };
        if previous_response_id.is_none() {
            trace.push("V3Target10ConcreteProviderSelected");
        }
        if let Some(sink) = route_selection_event_sink.as_ref() {
            let transport_label = if standardized
                .body
                .get("stream")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                "sse"
            } else {
                "json"
            };
            let observability = build_v3_direct_runtime_observability(
                &selected,
                transport_label,
                None,
                "in_progress",
                provider_failure_events.clone(),
                false,
            );
            sink(&observability);
        }
        let mut provider_action_permit: Option<V3ProviderActionPermit> = None;
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
            {
                Ok(V3ProviderActionRecoveryTransition::Admitted(mut admission)) => {
                    provider_action_permit = admission.take_permit();
                    trace.push("V3ProviderActionGateAdmission");
                }
                Ok(V3ProviderActionRecoveryTransition::Superseded(ticket)) => {
                    pending_provider_action_recovery = match ticket.recovery_witness() {
                        Ok(witness) => Some(witness),
                        Err(error) => {
                            return error_output(
                                runtime_source("V3ProviderActionGateAdmission", error),
                                trace,
                                &hook_registry,
                            )
                        }
                    };
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                Ok(V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket)) => {
                    pending_provider_action_recovery = match ticket.recovery_witness() {
                        Ok(witness) => Some(witness),
                        Err(error) => {
                            return error_output(
                                runtime_source("V3ProviderActionGateAdmission", error),
                                trace,
                                &hook_registry,
                            )
                        }
                    };
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                Err(error) => {
                    return error_output(
                        runtime_source("V3ProviderActionGateAdmission", error),
                        trace,
                        &hook_registry,
                    )
                }
            }
        }
        if continuation_provider_action_lookup {
            continuation_provider_action_lookup = false;
            match provider_health
                .wait_for_exact_selected_provider_action(manifest, &direct_server_id, &selected)
                .await
            {
                Ok(Some(admission))
                    if admission.released_by_success || admission.reevaluate_after_terminal =>
                {
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                Ok(Some(mut admission)) => {
                    provider_action_permit = admission.take_permit();
                    trace.push("V3ProviderActionGateAdmission");
                }
                Ok(None) => {}
                Err(error) => {
                    return error_output(
                        runtime_source("V3ProviderActionGateAdmission", error),
                        trace,
                        &hook_registry,
                    )
                }
            }
        }
        if !availability
            .availability(
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                now_epoch_ms,
            )
            .available
        {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3HubReqTarget06Resolved",
                "selected_provider_unavailable",
                "selected provider is unavailable",
            );
            drop(provider_action_permit.take());
            let policy_result = match run_v3_direct_provider_failure_policy(
                &V3DirectProviderFailurePolicyContext {
                    server_id: &direct_server_id,
                    routing_group: &direct_routing_group,
                    provider_health: &provider_health,
                    hook_registry: &hook_registry,
                    availability: &availability,
                    expanded: expanded.as_ref(),
                    provider_pinned: previous_response_id.is_some(),
                    now_epoch_ms,
                },
                &selected,
                source,
                503,
                &mut V3DirectProviderFailurePolicyState {
                    failed_candidates: &mut failed_candidates,
                    same_candidate_retries: &mut same_candidate_retries,
                    trace: &mut trace,
                },
            )
            .await
            {
                Ok(result) => result,
                Err(source) => return error_output(source, trace, &hook_registry),
            };
            if let Some(event) = policy_result.event.clone() {
                provider_failure_events.push(event.clone());
                publish_v3_direct_provider_failure_event(
                    provider_failure_event_sink.as_ref(),
                    &selected,
                    "json",
                    Some(event.status),
                    &provider_failure_events,
                    &event,
                );
            }
            match &policy_result.decision.action {
                V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                    pending_provider_action_recovery = Some(recovery.clone());
                    continue;
                }
                V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                    retry_selected = policy_result.retry_selected.map(|selected| *selected);
                    pending_provider_action_recovery = Some(recovery.clone());
                    continue;
                }
                V3Error05ExecutionAction::ProjectTerminal => {
                    if let Err(error) = release_terminal_failure_locator(
                        continuation_state,
                        previous_response_id.as_deref(),
                    ) {
                        return error_output(
                            runtime_source("V3HubRespContinuation04Committed", error),
                            trace,
                            &hook_registry,
                        );
                    }
                    if previous_response_id.is_some() {
                        trace.push("V3HubRespContinuation04Committed");
                    }
                    let terminal = policy_result
                        .decision
                        .try_into_terminal()
                        .expect("ProjectTerminal Error05 must be terminal");
                    return projected_error_output_with_observability(
                        build_v3_error_06_client_projected_from_v3_error_05(terminal),
                        trace,
                        None,
                    );
                }
                V3Error05ExecutionAction::ClientDisconnected
                | V3Error05ExecutionAction::RejectNonProviderError => {
                    return error_output(
                        runtime_source(
                            "V3Error05ExecutionDecision",
                            "provider availability failure entered a non-provider Error05 lane",
                        ),
                        trace,
                        &hook_registry,
                    )
                }
            }
        }
        let decision = match build_v3_execution_11_protocol_decision_from_v3_target_10(
            selected.clone(),
            "responses",
            &allowed_modes,
        ) {
            Ok(decision) => decision,
            Err(source) => {
                trace.push("V3Execution11ProtocolDecision");
                return error_output(source, trace, &hook_registry);
            }
        };
        trace.push("V3Execution11ProtocolDecision");
        if !matches!(
            decision.mode,
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        ) {
            if previous_response_id.is_some() {
                return error_output(
                    runtime_source(
                        "V3Execution11ProtocolDecision",
                        "Responses direct continuation cannot hand off to Relay after Req03 owner selected direct",
                    ),
                    trace,
                    &hook_registry,
                );
            }
            if let Err(source) = clear_v3_responses_direct_stopless_control_on_pre_resp03_terminal(
                manifest,
                &standardized.protocol_context.server_id,
                stopless_control,
                stopless_scope.as_ref(),
                direct_stopless_request_state.as_ref(),
            ) {
                return error_output(source, trace, &hook_registry);
            }
            return relay_handoff_output(decision.target, trace, provider_failure_events.clone());
        }
        if !direct_stopless_control_prepared {
            match prepare_v3_responses_direct_stopless_control_request(
                manifest,
                &standardized.protocol_context.server_id,
                stopless_control,
                stopless_scope.as_ref(),
                &mut standardized.body,
                &standardized.protocol_context.request_id,
                now_epoch_ms,
                &mut trace,
            ) {
                Ok(state) => {
                    direct_stopless_request_state = state;
                    direct_stopless_control_prepared = true;
                }
                Err(source) => return error_output(source, trace, &hook_registry),
            }
        }

        let selected_pin = V3RemoteContinuationPin::new(
            selected.candidate.provider_id.clone(),
            selected.candidate.model_id.clone(),
            selected.candidate.auth_alias.clone(),
        );
        let selected_capability_revision =
            match capability_revision_for_pin(manifest, &selected_pin) {
                Ok(revision) => revision,
                Err(error) => {
                    return error_output(
                        runtime_source("V3HubRespContinuation04Committed", error),
                        trace,
                        &hook_registry,
                    )
                }
            };
        let policy = hook_registry.run_route(selected, &standardized);
        trace.push("V3ResponsesDirect11Policy");

        let wire = match hook_registry.run_request_projection(&policy) {
            Ok(value) => value,
            Err(source) => {
                if let Err(error) = release_terminal_failure_locator(
                    continuation_state,
                    previous_response_id.as_deref(),
                ) {
                    return error_output(
                        runtime_source("V3HubRespContinuation04Committed", error),
                        trace,
                        &hook_registry,
                    );
                }
                if previous_response_id.is_some() {
                    trace.push("V3HubRespContinuation04Committed");
                }
                return error_output(source, trace, &hook_registry);
            }
        };
        trace.push("V3Provider12ResponsesWirePayload");

        let transport_request = match hook_registry.run_provider_transport(wire) {
            Ok(value) => value,
            Err(source) => {
                if let Err(error) = release_terminal_failure_locator(
                    continuation_state,
                    previous_response_id.as_deref(),
                ) {
                    return error_output(
                        runtime_source("V3HubRespContinuation04Committed", error),
                        trace,
                        &hook_registry,
                    );
                }
                if previous_response_id.is_some() {
                    trace.push("V3HubRespContinuation04Committed");
                }
                return error_output(source, trace, &hook_registry);
            }
        };
        trace.push("V3Transport13ResponsesHttpRequest");

        if let Err(error) = runtime_timing.start_external() {
            return error_output(
                runtime_source("V3RuntimeTimingExternal", error),
                trace,
                &hook_registry,
            );
        }
        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(error) => {
                if let Err(timing_error) = runtime_timing.finish_external() {
                    return error_output(
                        runtime_source("V3RuntimeTimingExternal", timing_error),
                        trace,
                        &hook_registry,
                    );
                }
                let source =
                    build_v3_provider_error_source("V3Transport13ResponsesHttpRequest", error);
                drop(provider_action_permit.take());
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        server_id: &direct_server_id,
                        routing_group: &direct_routing_group,
                        provider_health: &provider_health,
                        hook_registry: &hook_registry,
                        availability: &availability,
                        expanded: expanded.as_ref(),
                        provider_pinned: previous_response_id.is_some(),
                        now_epoch_ms,
                    },
                    &policy.target,
                    source,
                    502,
                    &mut V3DirectProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                )
                .await
                {
                    Ok(result) => result,
                    Err(source) => return error_output(source, trace, &hook_registry),
                };
                if let Some(event) = policy_result.event.clone() {
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink.as_ref(),
                        &policy.target,
                        "json",
                        Some(event.status),
                        &provider_failure_events,
                        &event,
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::ProjectTerminal => {
                        if let Err(release_error) = release_terminal_failure_locator(
                            continuation_state,
                            previous_response_id.as_deref(),
                        ) {
                            return error_output(
                                runtime_source("V3HubRespContinuation04Committed", release_error),
                                trace,
                                &hook_registry,
                            );
                        }
                        if previous_response_id.is_some() {
                            trace.push("V3HubRespContinuation04Committed");
                        }
                        let observability = build_v3_direct_runtime_observability(
                            &policy.target,
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                            false,
                        );
                        let terminal = policy_result
                            .decision
                            .try_into_terminal()
                            .expect("ProjectTerminal Error05 must be terminal");
                        let projected =
                            build_v3_error_06_client_projected_from_v3_error_05(terminal);
                        return projected_error_output_with_observability(
                            projected,
                            trace,
                            Some(observability),
                        );
                    }
                    V3Error05ExecutionAction::ClientDisconnected => {
                        let terminal = policy_result
                            .decision
                            .try_into_terminal()
                            .expect("ClientDisconnected Error05 must be terminal");
                        return projected_error_output_with_observability(
                            build_v3_error_06_client_projected_from_v3_error_05(terminal),
                            trace,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::RejectNonProviderError => {
                        return error_output(
                            runtime_source(
                                "V3Error05ExecutionDecision",
                                "provider failure entered a non-provider Error05 lane",
                            ),
                            trace,
                            &hook_registry,
                        )
                    }
                }
            }
        };
        let provider_response_is_stream =
            provider_raw.body_kind() == V3ProviderResponseBodyKind::Sse;
        if !provider_response_is_stream {
            if let Err(error) = runtime_timing.finish_external() {
                return error_output(
                    runtime_source("V3RuntimeTimingExternal", error),
                    trace,
                    &hook_registry,
                );
            }
        }
        let provider_status = provider_raw.status();
        trace.push("V3ProviderResp14Raw");

        let mut response_projection =
            match hook_registry.run_response_projection(provider_raw).await {
                Ok(projection) => projection,
                Err(source) => {
                    if provider_response_is_stream {
                        if let Err(error) = runtime_timing.finish_external() {
                            return error_output(
                                runtime_source("V3RuntimeTimingExternal", error),
                                trace,
                                &hook_registry,
                            );
                        }
                    }
                    if !matches!(source.source_kind, V3ErrorSourceKind::ProviderFailure) {
                        if let Err(error) = release_terminal_failure_locator(
                            continuation_state,
                            previous_response_id.as_deref(),
                        ) {
                            return error_output(
                                runtime_source("V3HubRespContinuation04Committed", error),
                                trace,
                                &hook_registry,
                            );
                        }
                        if previous_response_id.is_some() {
                            trace.push("V3HubRespContinuation04Committed");
                        }
                        return error_output(source, trace, &hook_registry);
                    }
                    drop(provider_action_permit.take());
                    let policy_result = match run_v3_direct_provider_failure_policy(
                        &V3DirectProviderFailurePolicyContext {
                            server_id: &direct_server_id,
                            routing_group: &direct_routing_group,
                            provider_health: &provider_health,
                            hook_registry: &hook_registry,
                            availability: &availability,
                            expanded: expanded.as_ref(),
                            provider_pinned: previous_response_id.is_some(),
                            now_epoch_ms,
                        },
                        &policy.target,
                        source,
                        provider_status,
                        &mut V3DirectProviderFailurePolicyState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            trace: &mut trace,
                        },
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(source) => return error_output(source, trace, &hook_registry),
                    };
                    if let Some(event) = policy_result.event.clone() {
                        provider_failure_events.push(event.clone());
                        publish_v3_direct_provider_failure_event(
                            provider_failure_event_sink.as_ref(),
                            &policy.target,
                            "json",
                            Some(event.status),
                            &provider_failure_events,
                            &event,
                        );
                    }
                    match &policy_result.decision.action {
                        V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                            pending_provider_action_recovery = Some(recovery.clone());
                            continue;
                        }
                        V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                            retry_selected = policy_result.retry_selected.map(|selected| *selected);
                            pending_provider_action_recovery = Some(recovery.clone());
                            continue;
                        }
                        V3Error05ExecutionAction::ProjectTerminal => {
                            if let Err(error) = release_terminal_failure_locator(
                                continuation_state,
                                previous_response_id.as_deref(),
                            ) {
                                return error_output(
                                    runtime_source("V3HubRespContinuation04Committed", error),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            if previous_response_id.is_some() {
                                trace.push("V3HubRespContinuation04Committed");
                            }
                            let observability = build_v3_direct_runtime_observability(
                                &policy.target,
                                "json",
                                policy_result.event.as_ref().map(|event| event.status),
                                "failed",
                                provider_failure_events.clone(),
                                false,
                            );
                            let terminal = policy_result
                                .decision
                                .try_into_terminal()
                                .expect("ProjectTerminal Error05 must be terminal");
                            let projected =
                                build_v3_error_06_client_projected_from_v3_error_05(terminal);
                            return projected_error_output_with_observability(
                                projected,
                                trace,
                                Some(observability),
                            );
                        }
                        V3Error05ExecutionAction::ClientDisconnected => {
                            let terminal = policy_result
                                .decision
                                .try_into_terminal()
                                .expect("ClientDisconnected Error05 must be terminal");
                            return projected_error_output_with_observability(
                                build_v3_error_06_client_projected_from_v3_error_05(terminal),
                                trace,
                                None,
                            );
                        }
                        V3Error05ExecutionAction::RejectNonProviderError => {
                            return error_output(
                                runtime_source(
                                    "V3Error05ExecutionDecision",
                                    "provider failure entered a non-provider Error05 lane",
                                ),
                                trace,
                                &hook_registry,
                            )
                        }
                    }
                }
            };
        trace.push("V3DirectResp14ProviderProjectionPrepared");
        let mut direct_stopless_projected = false;
        if let V3ClientBody::Json(body) = &mut response_projection.client_payload.body {
            match apply_v3_responses_direct_stopless_json_response_control(
                V3ResponsesDirectStoplessJsonResponseControlInput {
                    manifest,
                    server_id: &standardized.protocol_context.server_id,
                    stopless_control,
                    stopless_scope: stopless_scope.as_ref(),
                    request_stopless_state: direct_stopless_request_state.as_ref(),
                    transition_request_id: &standardized.protocol_context.request_id,
                    transition_updated_at: now_epoch_ms,
                    payload: body,
                },
                &mut trace,
            ) {
                Ok(outcome) => {
                    direct_stopless_projected = outcome.intercepted;
                    match outcome.continuation_transition {
                        V3DirectStoplessContinuationTransition::PassThrough => {}
                        V3DirectStoplessContinuationTransition::Continue { response_id } => {
                            response_projection.remote_continuation =
                                V3RemoteContinuationObservation::Pending { response_id };
                        }
                        V3DirectStoplessContinuationTransition::Terminal => {
                            response_projection.remote_continuation =
                                V3RemoteContinuationObservation::Terminal;
                        }
                    }
                }
                Err(source) => return error_output(source, trace, &hook_registry),
            }
        }
        if let V3RemoteContinuationObservation::Streaming { state } =
            &response_projection.remote_continuation
        {
            let stream_observation = V3RuntimeStreamObservation::default();
            let body = std::mem::replace(
                &mut response_projection.client_payload.body,
                V3ClientBody::Bytes(Vec::new()),
            );
            response_projection.client_payload.body = match body {
                V3ClientBody::Sse(stream) => {
                    let stream = wrap_direct_sse_provider_event_json_observation_stream(
                        stream,
                        stream_observation.clone(),
                        runtime_timing.clone(),
                    );
                    let stream = wrap_direct_sse_stopless_control_stream(
                        stream,
                        V3DirectSseStoplessControlPolicy {
                            stopless_center_enabled:
                                v3_responses_direct_stopless_center_enabled_for_server(
                                    manifest,
                                    &standardized.protocol_context.server_id,
                                ),
                            stopless_control: stopless_control.cloned(),
                            stopless_scope: stopless_scope.clone(),
                            request_stopless_state: direct_stopless_request_state.clone(),
                            transition_request_id: standardized.protocol_context.request_id.clone(),
                            transition_updated_at: now_epoch_ms,
                            previous_response_id: previous_response_id.clone(),
                            continuation_state: continuation_state.cloned(),
                            continuation_scope: continuation_scope.clone(),
                            selected_pin: selected_pin.clone(),
                            selected_capability_revision: selected_capability_revision.clone(),
                        },
                    );
                    V3ClientBody::Sse(stream)
                }
                other => other,
            };
            if let (Some(continuation_state), Some(scope)) =
                (continuation_state, continuation_scope.as_ref())
            {
                let body = std::mem::replace(
                    &mut response_projection.client_payload.body,
                    V3ClientBody::Bytes(Vec::new()),
                );
                response_projection.client_payload.body = match body {
                    V3ClientBody::Sse(stream) => {
                        let policy = V3DirectSseRemoteContinuationPolicy {
                            state: continuation_state.clone(),
                            scope_key: scope.key.clone(),
                            previous_response_id: previous_response_id.clone(),
                            selected_pin: selected_pin.clone(),
                            selected_capability_revision: selected_capability_revision.clone(),
                            now_epoch_ms,
                            committed_pending: false,
                        };
                        V3ClientBody::Sse(wrap_direct_sse_remote_continuation_stream(
                            stream,
                            state.clone(),
                            policy,
                        ))
                    }
                    other => other,
                };
            }
            let body = std::mem::replace(
                &mut response_projection.client_payload.body,
                V3ClientBody::Bytes(Vec::new()),
            );
            response_projection.client_payload.body = match body {
                V3ClientBody::Sse(stream) => {
                    V3ClientBody::Sse(wrap_direct_sse_provider_outcome_stream(
                        stream,
                        V3DirectSseProviderOutcome {
                            provider_health: provider_health.clone(),
                            server_id: direct_server_id.clone(),
                            routing_group: direct_routing_group.clone(),
                            provider_id: policy.target.candidate.provider_id.clone(),
                            auth_alias: policy.target.candidate.auth_alias.clone(),
                            model_id: policy.target.candidate.model_id.clone(),
                            terminal: false,
                            seen_done: false,
                            recorded: false,
                            _provider_action_permit: provider_action_permit.take(),
                        },
                        runtime_timing.clone(),
                        stream_observation.clone(),
                    ))
                }
                other => other,
            };
            trace.push("V3DirectResp15ClientPayloadReady");
            trace.push("V3Resp15ClientPayload");

            return V3ResponsesDirectRuntimeOutput {
                observability: Some(build_v3_direct_runtime_observability(
                    &policy.target,
                    v3_direct_client_transport_label(&response_projection.client_payload),
                    Some(provider_status),
                    "streaming",
                    provider_failure_events.clone(),
                    direct_stopless_request_state.is_some(),
                )),
                stream_observation: Some(stream_observation),
                client_payload: response_projection.client_payload,
                node_trace: trace,
                error_chain: None,
                protocol_relay_handoff: None,
            };
        }
        if let (Some(state), Some(scope)) = (continuation_state, continuation_scope.as_ref()) {
            let pending_response_id = match &response_projection.remote_continuation {
                V3RemoteContinuationObservation::Pending { response_id } => {
                    Some(response_id.clone())
                }
                V3RemoteContinuationObservation::Terminal => None,
                V3RemoteContinuationObservation::Streaming { .. } => unreachable!(
                    "streaming Responses continuation is handled before material lifecycle"
                ),
            };
            let lifecycle_changed = previous_response_id.is_some() || pending_response_id.is_some();
            if lifecycle_changed {
                if let Some(response_id) = pending_response_id {
                    let locator = V3RemoteContinuationLocator::new_direct(
                        response_id,
                        scope.key.clone(),
                        selected_pin,
                        selected_capability_revision,
                        now_epoch_ms,
                        now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
                    );
                    let input = V3RemoteContinuationCommitInput::locator_only(locator);
                    let mut store = match state.store.lock() {
                        Ok(store) => store,
                        Err(error) => {
                            return error_output(
                                runtime_source("V3HubRespContinuation04Committed", error),
                                trace,
                                &hook_registry,
                            )
                        }
                    };
                    let commit = match previous_response_id.as_deref() {
                        Some(previous_response_id) => {
                            store.rebind_for_resp04(previous_response_id, input)
                        }
                        None => store.commit(input),
                    };
                    if let Err(error) = commit {
                        return error_output(
                            runtime_source("V3HubRespContinuation04Committed", error),
                            trace,
                            &hook_registry,
                        );
                    }
                } else if let Some(previous_response_id) = previous_response_id.as_deref() {
                    let mut store = match state.store.lock() {
                        Ok(store) => store,
                        Err(error) => {
                            return error_output(
                                runtime_source("V3HubRespContinuation04Committed", error),
                                trace,
                                &hook_registry,
                            )
                        }
                    };
                    if !store.release(previous_response_id) {
                        return error_output(
                            runtime_source(
                                "V3HubRespContinuation04Committed",
                                format!(
                                    "terminal locator {previous_response_id} was not present at Resp04 release"
                                ),
                            ),
                            trace,
                            &hook_registry,
                        );
                    }
                }
                trace.push("V3HubRespContinuation04Committed");
            }
        }
        if let Err(source) = record_v3_direct_provider_success(
            &provider_health,
            &direct_server_id,
            &direct_routing_group,
            &policy.target,
            now_epoch_ms,
        ) {
            return error_output(source, trace, &hook_registry);
        }
        trace.push("V3DirectResp15ClientPayloadReady");
        trace.push("V3Resp15ClientPayload");
        let timing = match runtime_timing.finish_runtime() {
            Ok(timing) => timing,
            Err(error) => {
                return error_output(
                    runtime_source("V3RuntimeTimingTerminal", error),
                    trace,
                    &hook_registry,
                )
            }
        };
        let mut observability = build_v3_direct_runtime_observability(
            &policy.target,
            v3_direct_client_transport_label(&response_projection.client_payload),
            Some(provider_status),
            "completed",
            provider_failure_events.clone(),
            direct_stopless_projected,
        );
        observability.timing = Some(timing);

        return V3ResponsesDirectRuntimeOutput {
            observability: Some(observability),
            stream_observation: None,
            client_payload: response_projection.client_payload,
            node_trace: trace,
            error_chain: None,
            protocol_relay_handoff: None,
        };
    }
}

struct V3ResponsesDirectStoplessJsonResponseControlInput<'a> {
    manifest: &'a V3Config05ManifestPublished,
    server_id: &'a str,
    stopless_control: Option<&'a V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&'a V3ResponsesDirectStoplessControlScope>,
    request_stopless_state: Option<&'a V3StoplessCenterState>,
    transition_request_id: &'a str,
    transition_updated_at: u64,
    payload: &'a mut Value,
}

#[derive(Debug, Clone, Default)]
struct V3ResponsesDirectStoplessJsonResponseControlOutcome {
    intercepted: bool,
    continuation_transition: V3DirectStoplessContinuationTransition,
}

#[derive(Debug, Clone, Default)]
enum V3DirectStoplessContinuationTransition {
    #[default]
    PassThrough,
    Continue {
        response_id: String,
    },
    Terminal,
}

fn prepare_v3_responses_direct_stopless_control_request(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    payload: &mut Value,
    transition_request_id: &str,
    transition_updated_at: u64,
    trace: &mut Vec<&'static str>,
) -> Result<Option<V3StoplessCenterState>, V3Error01SourceRaised> {
    if !v3_responses_direct_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(None);
    }
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(None);
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(None);
    }
    trace.push("V3DirectStoplessReq01RuntimeControlLoaded");
    let restored_state = stopless_control
        .load_for_scope(stopless_scope)
        .map_err(|error| runtime_source("V3DirectStoplessReq01RuntimeControlLoaded", error))?;
    let restored_state_loaded = restored_state.is_some();
    let mut events = Vec::<V3HubRelayRequestHookEvent>::new();
    let request_state = apply_v3_stopless_request_hook_at_req04(
        payload,
        &mut events,
        restored_state.as_ref(),
        Some(transition_request_id),
        Some(transition_updated_at),
    )
    .map(|state| state.map(|state| state.with_max_stop_budget_floor(4)))
    .map_err(|error| runtime_source("V3DirectStoplessReq03GuidanceToolInjected", error))?;
    if events.iter().any(|event| {
        matches!(
            event,
            V3HubRelayRequestHookEvent::Req04StoplessCliNoopObserved
        )
    }) {
        trace.push("V3DirectStoplessReq02NoopCliConsumed");
        project_v3_direct_stopless_native_reasoning_stop_output(payload, restored_state.as_ref())?;
    }
    if request_state.is_some() {
        trace.push("V3DirectStoplessReq03GuidanceToolInjected");
    }
    apply_v3_responses_direct_stopless_control_request_transition(
        manifest,
        server_id,
        Some(stopless_control),
        Some(stopless_scope),
        restored_state_loaded,
        request_state.as_ref(),
    )?;
    Ok(request_state)
}

fn project_v3_direct_stopless_native_reasoning_stop_output(
    payload: &mut Value,
    restored_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    let Some(call_id) = restored_state
        .and_then(V3StoplessCenterState::last_provider_stopless_call_id)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let input = payload
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            runtime_source(
                "V3DirectStoplessReq02NoopCliConsumed",
                "Direct stopless native reasoningStop continuation requires Responses input array",
            )
        })?;
    let already_projected = input.iter().any(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call_output" | "tool_call_output")
        ) && item
            .get("call_id")
            .or_else(|| item.get("tool_call_id"))
            .and_then(Value::as_str)
            .is_some_and(|existing| existing == call_id)
    });
    if already_projected {
        return Ok(());
    }
    input.insert(
        0,
        json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": ""
        }),
    );
    Ok(())
}

fn apply_v3_responses_direct_stopless_json_response_control(
    input: V3ResponsesDirectStoplessJsonResponseControlInput<'_>,
    trace: &mut Vec<&'static str>,
) -> Result<V3ResponsesDirectStoplessJsonResponseControlOutcome, V3Error01SourceRaised> {
    let Some(request_stopless_state) = input.request_stopless_state else {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    };
    if !v3_responses_direct_stopless_center_enabled_for_server(input.manifest, input.server_id) {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    }
    let (Some(stopless_control), Some(stopless_scope)) =
        (input.stopless_control, input.stopless_scope)
    else {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    }
    trace.push("V3DirectStoplessResp01EvidenceObserved");
    let outcome = run_v3_responses_direct_stopless_response_hooks(
        input.payload.clone(),
        request_stopless_state,
        input.transition_request_id,
        input.transition_updated_at,
        V3HubTransportIntent::Json,
    )?;
    *input.payload = outcome.payload;
    let continuation_transition = if !outcome.intercepted {
        V3DirectStoplessContinuationTransition::PassThrough
    } else if outcome
        .center_state
        .as_ref()
        .is_some_and(V3StoplessCenterState::need_continue)
    {
        let response_id = direct_response_id(input.payload).ok_or_else(|| {
            runtime_source(
                "V3HubRespContinuation04Committed",
                "Direct stopless continue transition requires provider-native response id",
            )
        })?;
        V3DirectStoplessContinuationTransition::Continue { response_id }
    } else {
        V3DirectStoplessContinuationTransition::Terminal
    };
    apply_v3_responses_direct_stopless_control_response_transition(
        input.manifest,
        input.server_id,
        Some(stopless_control),
        Some(stopless_scope),
        outcome.center_state,
    )?;
    trace.push("V3DirectStoplessResp02RuntimeControlUpdated");
    if outcome.intercepted {
        trace.push("V3DirectStoplessResp03NoopCliOrTerminalProjected");
    }
    Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome {
        intercepted: outcome.intercepted,
        continuation_transition,
    })
}

struct V3DirectStoplessResponseHookOutcome {
    payload: Value,
    center_state: Option<V3StoplessCenterState>,
    intercepted: bool,
}

fn run_v3_responses_direct_stopless_response_hooks(
    payload: Value,
    request_stopless_state: &V3StoplessCenterState,
    transition_request_id: &str,
    transition_updated_at: u64,
    transport_intent: V3HubTransportIntent,
) -> Result<V3DirectStoplessResponseHookOutcome, V3Error01SourceRaised> {
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&payload) {
        return Err(runtime_source(
            "V3DirectStoplessResp01EvidenceObserved",
            format!("provider response leaked RouteCodex side-channel field: {key}"),
        ));
    }
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        payload,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubContinuationOwnership::RemoteProviderOwned,
            V3HubExecutionMode::Direct,
            V3HubInvocationSource::Client,
            transport_intent,
        ),
    );
    let resp02 = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(resp02);
    let profile = V3HubRelayResponseHookProfile::empty()
        .with_stopless_reasoning_stop()
        .with_stopless_center_state(request_stopless_state.clone())
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
    let tool_outcome = apply_v3_tool_call_servertool_hook_at_resp03(resp02, &profile)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    if tool_outcome.intercepted {
        return Ok(V3DirectStoplessResponseHookOutcome {
            payload: tool_outcome.input.provider_payload().as_ref().clone(),
            center_state: tool_outcome.center_state,
            intercepted: true,
        });
    }
    if direct_response_has_provider_tool_call(tool_outcome.input.provider_payload().as_ref()) {
        return Ok(V3DirectStoplessResponseHookOutcome {
            payload: tool_outcome.input.provider_payload().as_ref().clone(),
            center_state: None,
            intercepted: false,
        });
    }
    let stop_outcome = apply_v3_stop_servertool_hook_at_resp03(tool_outcome.input, &profile)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    Ok(V3DirectStoplessResponseHookOutcome {
        payload: stop_outcome.input.provider_payload().as_ref().clone(),
        center_state: stop_outcome.center_state,
        intercepted: stop_outcome.intercepted,
    })
}

fn apply_v3_responses_direct_stopless_control_request_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    restored_state_loaded: bool,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    match request_stopless_state {
        Some(state) => store_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
            state.clone(),
        ),
        None if restored_state_loaded => clear_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
        ),
        None => Ok(()),
    }
}

fn apply_v3_responses_direct_stopless_control_response_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    response_stopless_state: Option<V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    match response_stopless_state {
        Some(state) => store_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
            state,
        ),
        None => clear_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
        ),
    }
}

fn store_v3_responses_direct_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    state: V3StoplessCenterState,
) -> Result<(), V3Error01SourceRaised> {
    if !v3_responses_direct_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(());
    }
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .store_for_scope(stopless_scope, state)
        .map_err(|error| runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error))
}

fn clear_v3_responses_direct_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
) -> Result<(), V3Error01SourceRaised> {
    if !v3_responses_direct_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(());
    }
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .clear_for_scope(stopless_scope)
        .map_err(|error| runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error))
}

fn clear_v3_responses_direct_stopless_control_on_pre_resp03_terminal(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    if request_stopless_state.is_none() {
        return Ok(());
    }
    clear_v3_responses_direct_stopless_control_state(
        manifest,
        server_id,
        stopless_control,
        stopless_scope,
    )
}

fn commit_v3_direct_stopless_remote_locator_for_payload(
    payload: &Value,
    previous_response_id: Option<&str>,
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    continuation_scope: Option<&V3ResponsesDirectContinuationScope>,
    selected_pin: &V3RemoteContinuationPin,
    selected_capability_revision: &str,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    let Some(response_id) = direct_response_id(payload) else {
        return Err(runtime_source(
            "V3HubRespContinuation04Committed",
            "Direct stopless no-op projection requires native response id for remote continuation",
        ));
    };
    let (Some(continuation_state), Some(continuation_scope)) =
        (continuation_state, continuation_scope)
    else {
        return Err(runtime_source(
            "V3HubRespContinuation04Committed",
            "Direct stopless no-op projection requires direct continuation state/scope",
        ));
    };
    let locator = V3RemoteContinuationLocator::new_direct(
        response_id,
        continuation_scope.key.clone(),
        selected_pin.clone(),
        selected_capability_revision.to_string(),
        now_epoch_ms,
        now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
    );
    let input = V3RemoteContinuationCommitInput::locator_only(locator);
    let mut store = continuation_state
        .store
        .lock()
        .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
    let commit = match previous_response_id {
        Some(previous_response_id) => store.rebind_for_resp04(previous_response_id, input),
        None => store.commit(input),
    };
    commit.map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))
}

fn direct_response_id(payload: &Value) -> Option<String> {
    payload
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/response/id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
}

fn direct_response_has_provider_tool_call(payload: &Value) -> bool {
    let semantic = payload.get("response").unwrap_or(payload);
    if matches!(
        semantic.get("status").and_then(Value::as_str),
        Some("requires_action" | "in_progress")
    ) {
        return true;
    }
    semantic
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "custom_tool_call" | "tool_call")
                )
            })
        })
        || matches!(
            payload.pointer("/item/type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call" | "tool_call")
        )
}

fn direct_runtime_allowed_execution_modes(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Vec<String> {
    manifest
        .servers
        .get(server_id)
        .and_then(|server| server.execution.as_ref())
        .map(|execution| execution.allowed_modes.clone())
        .filter(|modes| !modes.is_empty())
        .unwrap_or_else(|| vec!["direct".to_string()])
}

struct V3DirectProviderFailurePolicyResult {
    decision: V3Error05ExecutionDecision,
    retry_selected: Option<Box<routecodex_v3_target::V3Target10ConcreteProviderSelected>>,
    event: Option<V3RuntimeProviderFailureObservation>,
}

struct V3DirectProviderFailurePolicyContext<'ctx, R: V3ProviderAvailabilityReader + ?Sized> {
    server_id: &'ctx str,
    routing_group: &'ctx str,
    provider_health: &'ctx V3ProviderFailureRuntimeHealth,
    hook_registry: &'ctx V3HookRegistry,
    availability: &'ctx R,
    expanded: Option<&'ctx routecodex_v3_target::V3Target09CandidateSetExpanded>,
    provider_pinned: bool,
    now_epoch_ms: u64,
}

struct V3DirectProviderFailurePolicyState<'state> {
    failed_candidates: &'state mut BTreeSet<String>,
    same_candidate_retries: &'state mut BTreeMap<String, usize>,
    trace: &'state mut Vec<&'static str>,
}

fn record_v3_direct_provider_failure_record(
    provider_health: &V3ProviderFailureRuntimeHealth,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: &V3Error01SourceRaised,
    now_epoch_ms: u64,
) -> Result<V3ProviderFailureRecord, V3Error01SourceRaised> {
    provider_health
        .record_provider_failure_record(
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            Some(&source.message),
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

fn record_v3_direct_provider_success(
    provider_health: &V3ProviderFailureRuntimeHealth,
    server_id: &str,
    routing_group: &str,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    provider_health
        .record_provider_success_in_scope(
            server_id,
            routing_group,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            now_epoch_ms,
        )
        .map_err(|error| runtime_source("V3ProviderHealthStateMutated", error))
}

async fn run_v3_direct_provider_failure_policy<R: V3ProviderAvailabilityReader>(
    context: &V3DirectProviderFailurePolicyContext<'_, R>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    state: &mut V3DirectProviderFailurePolicyState<'_>,
) -> Result<V3DirectProviderFailurePolicyResult, V3Error01SourceRaised> {
    if matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect) {
        let decision = context.hook_registry.run_error(
            source,
            V3ErrorActionScope::ProviderInstance {
                provider_id: selected.candidate.provider_id.clone(),
            },
            0,
            false,
            false,
            None,
        );
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event: None,
        });
    }
    let health_record = record_v3_direct_provider_failure_record(
        context.provider_health,
        selected,
        &source,
        context.now_epoch_ms,
    )?;

    let failed_key = candidate_key(&selected.candidate);
    let expanded_candidates = match (context.expanded, context.provider_pinned) {
        (Some(expanded), _) => Some(&expanded.candidates),
        (None, true) => None,
        (None, false) => {
            return Err(runtime_source(
                "V3Target09CandidateSetExpanded",
                "routed candidate set missing",
            ))
        }
    };
    let mut failed_with_current = state.failed_candidates.clone();
    failed_with_current.insert(failed_key.clone());
    let remaining = expanded_candidates.map_or(0, |expanded_candidates| {
        remaining_available_candidates(
            expanded_candidates,
            context.availability,
            &failed_with_current,
        )
    });
    let next_provider_key = expanded_candidates.and_then(|expanded_candidates| {
        first_remaining_available_candidate_key(
            expanded_candidates,
            context.availability,
            &failed_with_current,
        )
    });
    let provider_scope = V3ErrorActionScope::ProviderInstance {
        provider_id: selected.candidate.provider_id.clone(),
    };
    let retries_done = *state.same_candidate_retries.get(&failed_key).unwrap_or(&0);
    let same_provider_retry_available = remaining == 0
        && (context.provider_pinned
            || selected.default_floor_protected
            || selected.candidate.default_pool_member)
        && retries_done < V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET;
    let recovery_record = if remaining > 0 || same_provider_retry_available {
        Some(
            context
                .provider_health
                .record_provider_action_failure(
                    context.server_id,
                    context.routing_group,
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    &source.code,
                )
                .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?,
        )
    } else {
        None
    };
    let decision = context.hook_registry.run_error(
        source.clone(),
        provider_scope,
        remaining,
        false,
        same_provider_retry_available,
        match recovery_record.as_ref() {
            Some(record) => Some(
                record
                    .recovery_witness()
                    .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?,
            ),
            None => None,
        },
    );
    state
        .trace
        .extend(V3_ERROR_CHAIN_NODE_IDS.iter().take(5).copied());
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ) {
        let failure_record = recovery_record
            .as_ref()
            .expect("reselect Error05 must carry its recorded recovery witness");
        state.failed_candidates.insert(failed_key);
        state.trace.push("V3TargetLocalReselected");
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: None,
            event: Some(build_v3_direct_provider_failure_observation(
                selected,
                status,
                &source,
                &health_record,
                "switch_provider",
                next_provider_key,
                Some(failure_record.minimum_delay_ms),
            )),
        });
    }
    if matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenRetrySame { .. }
    ) {
        let retries_done = state.same_candidate_retries.entry(failed_key).or_insert(0);
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3DefaultFloorBackoffWait");
        let failure_record = recovery_record
            .as_ref()
            .expect("retry-same Error05 must carry its recorded recovery witness");
        return Ok(V3DirectProviderFailurePolicyResult {
            decision,
            retry_selected: Some(Box::new(selected.clone())),
            event: Some(build_v3_direct_provider_failure_observation(
                selected,
                status,
                &source,
                &health_record,
                "retry_provider",
                Some(candidate_key(&selected.candidate)),
                Some(failure_record.minimum_delay_ms),
            )),
        });
    }
    if !matches!(decision.action, V3Error05ExecutionAction::ProjectTerminal) {
        return Err(runtime_source(
            "V3Error05ExecutionDecision",
            format!(
                "provider failure produced invalid Error05 action {:?}",
                decision.action
            ),
        ));
    }
    let admission = context
        .provider_health
        .wait_for_terminal_provider_projection(
            context.server_id,
            context.routing_group,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            &source.code,
        )
        .await
        .map_err(|error| runtime_source("V3ProviderActionGateAdmission", error))?;
    state.trace.push("V3Error06ClientProjected");
    Ok(V3DirectProviderFailurePolicyResult {
        decision,
        retry_selected: None,
        event: Some(build_v3_direct_provider_failure_observation(
            selected,
            status,
            &source,
            &health_record,
            "terminal_default_floor_exhausted",
            None,
            Some(admission.minimum_delay_ms),
        )),
    })
}

fn build_v3_direct_provider_failure_observation(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    status: u16,
    source: &V3Error01SourceRaised,
    health_record: &V3ProviderFailureRecord,
    action: &str,
    next_provider_key: Option<String>,
    wait_ms: Option<u64>,
) -> V3RuntimeProviderFailureObservation {
    let observed_status = source
        .external_error
        .as_ref()
        .and_then(|external| external.status)
        .filter(|external_status| *external_status >= 400)
        .unwrap_or(status);
    V3RuntimeProviderFailureObservation {
        provider_key: candidate_key(&selected.candidate),
        provider_id: selected.candidate.provider_id.clone(),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        model_id: selected.candidate.model_id.clone(),
        status: observed_status,
        error_type: Some(source.code.clone()),
        external_error_kind: source
            .external_error
            .as_ref()
            .map(|external| external_kind_label(&external.kind).to_string()),
        external_error_code: source
            .external_error
            .as_ref()
            .and_then(|external| external.code.clone()),
        external_error_status: source
            .external_error
            .as_ref()
            .and_then(|external| external.status),
        internal_code: source
            .internal_error
            .as_ref()
            .map(|internal| internal.internal_code.to_string()),
        message: source.message.clone(),
        failure_count: health_record.failure_count,
        health_state: health_record.state.clone(),
        cooldown_until_ms: health_record.cooldown_until_ms,
        action: action.to_string(),
        next_provider_key,
        wait_ms,
    }
}

fn publish_v3_direct_provider_failure_event(
    sink: Option<&V3RuntimeProviderFailureEventSink>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    transport: &str,
    status: Option<u16>,
    provider_failure_events: &[V3RuntimeProviderFailureObservation],
    event: &V3RuntimeProviderFailureObservation,
) {
    if let Some(sink) = sink {
        let observability = build_v3_direct_runtime_observability(
            selected,
            transport,
            status,
            "failed",
            provider_failure_events.to_vec(),
            false,
        );
        sink(&observability, event);
    }
}

fn external_kind_label(kind: &V3ExternalErrorKind) -> &'static str {
    match kind {
        V3ExternalErrorKind::Provider => "provider",
        V3ExternalErrorKind::Upstream => "upstream",
        V3ExternalErrorKind::Client => "client",
        V3ExternalErrorKind::Transport => "transport",
    }
}

fn build_v3_direct_runtime_observability(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    transport: &str,
    provider_status: Option<u16>,
    response_status: &str,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    stopless_activation: bool,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
        execution_mode: "direct".to_string(),
        transport: transport.to_string(),
        routing_group_id: Some(selected.route.routing_group_id.clone()),
        pool_id: Some(selected.route.pool_id.clone()),
        provider_id: Some(selected.candidate.provider_id.clone()),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        provider_key: Some(candidate_key(&selected.candidate)),
        provider_type: Some(selected.candidate.provider_type.clone()),
        model_id: Some(selected.candidate.model_id.clone()),
        wire_model: Some(selected.candidate.wire_model.clone()),
        provider_status,
        response_status: Some(response_status.to_string()),
        finish_reason: None,
        stopless_activation,
        attempts: Some(selected.attempts),
        unavailable_candidates: selected.unavailable_candidates.clone(),
        provider_failure_events,
        target_path: selected.candidate.path.clone(),
        usage: None,
        timing: None,
    }
}

fn v3_direct_client_transport_label(payload: &V3Resp15ClientPayload) -> &str {
    match &payload.body {
        V3ClientBody::Json(_) => "json",
        V3ClientBody::Bytes(_) => "bytes",
        V3ClientBody::Sse(_) => "sse",
    }
}

fn release_terminal_failure_locator(
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    previous_response_id: Option<&str>,
) -> Result<(), String> {
    let (Some(state), Some(response_id)) = (continuation_state, previous_response_id) else {
        return Ok(());
    };
    let mut store = state.store.lock().map_err(|error| error.to_string())?;
    if !store.release(response_id) {
        return Err(format!(
            "terminal failure locator {response_id} was not present at Resp04 release"
        ));
    }
    Ok(())
}

struct V3DirectSseRemoteContinuationPolicy {
    state: V3ResponsesDirectContinuationState,
    scope_key: V3RemoteContinuationScopeKey,
    previous_response_id: Option<String>,
    selected_pin: V3RemoteContinuationPin,
    selected_capability_revision: String,
    now_epoch_ms: u64,
    committed_pending: bool,
}

fn wrap_direct_sse_remote_continuation_stream(
    source: V3ClientSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    policy: V3DirectSseRemoteContinuationPolicy,
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        observation_state: V3SseRemoteContinuationObservationState,
        policy: V3DirectSseRemoteContinuationPolicy,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            observation_state,
            policy,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            match state.source.next().await {
                Some(Ok(chunk)) => {
                    let result = state
                        .policy
                        .commit_observed_pending(&state.observation_state)
                        .map(|()| chunk);
                    if result.is_err() {
                        state.done = true;
                    }
                    Some((result, state))
                }
                Some(Err(error)) => {
                    state.done = true;
                    Some((Err(error), state))
                }
                None => match state.policy.release_terminal_previous() {
                    Ok(()) => None,
                    Err(error) => {
                        state.done = true;
                        Some((Err(error), state))
                    }
                },
            }
        },
    ))
}

fn wrap_direct_sse_provider_event_json_observation_stream(
    source: V3ClientSseStream,
    stream_observation: V3RuntimeStreamObservation,
    runtime_timing: V3RuntimeTimingState,
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        stream_observation: V3RuntimeStreamObservation,
        runtime_timing: V3RuntimeTimingState,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            stream_observation,
            runtime_timing,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            match state.source.next().await {
                Some(Ok(chunk)) => {
                    let result = record_direct_sse_provider_event_json_chunk(
                        &chunk,
                        &mut state.decoder,
                        &state.stream_observation,
                    )
                    .map(|()| chunk);
                    if result.is_err() {
                        state.done = true;
                    }
                    Some((result, state))
                }
                Some(Err(error)) => {
                    state.done = true;
                    Some((Err(error), state))
                }
                None => {
                    state.done = true;
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        SseIncrementalDecoder::new(SseTransportLimits::default()),
                    );
                    match decoder
                        .finish()
                        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
                    {
                        Ok(()) => match state.runtime_timing.finish_external() {
                            Ok(()) => None,
                            Err(error) => {
                                Some((Err(runtime_source("V3RuntimeTimingExternal", error)), state))
                            }
                        },
                        Err(error) => Some((Err(error), state)),
                    }
                }
            }
        },
    ))
}

fn record_direct_sse_provider_event_json_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
    for frame in frames {
        record_direct_sse_provider_event_json_frame(frame.frame().fields(), stream_observation)?;
    }
    Ok(())
}

fn record_direct_sse_provider_event_json_frame(
    fields: &[SseField],
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name != "data" {
            continue;
        }
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value);
    }
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let event: Value = serde_json::from_str(data).map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.to_string(),
        )
    })?;
    stream_observation
        .record_provider_event_json(&event)
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
}

#[derive(Clone)]
struct V3DirectSseStoplessControlPolicy {
    stopless_center_enabled: bool,
    stopless_control: Option<V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<V3ResponsesDirectStoplessControlScope>,
    request_stopless_state: Option<V3StoplessCenterState>,
    transition_request_id: String,
    transition_updated_at: u64,
    previous_response_id: Option<String>,
    continuation_state: Option<V3ResponsesDirectContinuationState>,
    continuation_scope: Option<V3ResponsesDirectContinuationScope>,
    selected_pin: V3RemoteContinuationPin,
    selected_capability_revision: String,
}

fn wrap_direct_sse_stopless_control_stream(
    source: V3ClientSseStream,
    policy: V3DirectSseStoplessControlPolicy,
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        policy: V3DirectSseStoplessControlPolicy,
        pending: VecDeque<Result<Vec<u8>, V3Error01SourceRaised>>,
        committed_stopless_locator: bool,
        state_transition_done: bool,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            policy,
            pending: VecDeque::new(),
            committed_stopless_locator: false,
            state_transition_done: false,
            done: false,
        },
        |mut state| async move {
            loop {
                if let Some(item) = state.pending.pop_front() {
                    return Some((item, state));
                }
                if state.done {
                    return None;
                }
                match state.source.next().await {
                    Some(Ok(chunk)) => {
                        match transform_direct_sse_stopless_control_chunk(
                            &chunk,
                            &mut state.decoder,
                            &state.policy,
                            &mut state.committed_stopless_locator,
                            &mut state.state_transition_done,
                        ) {
                            Ok(chunks) => {
                                state.pending.extend(chunks.into_iter().map(Ok));
                            }
                            Err(error) => {
                                state.done = true;
                                return Some((Err(error), state));
                            }
                        }
                    }
                    Some(Err(error)) => {
                        if let Err(clear_error) =
                            state.policy.clear_active_control_on_stream_terminal()
                        {
                            state.done = true;
                            return Some((Err(clear_error), state));
                        }
                        state.done = true;
                        return Some((Err(error), state));
                    }
                    None => {
                        let decoder = std::mem::replace(
                            &mut state.decoder,
                            SseIncrementalDecoder::new(SseTransportLimits::default()),
                        );
                        if let Err(error) = decoder
                            .finish()
                            .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
                        {
                            state.done = true;
                            return Some((Err(error), state));
                        }
                        if !state.state_transition_done {
                            if let Err(error) =
                                state.policy.clear_active_control_on_stream_terminal()
                            {
                                state.done = true;
                                return Some((Err(error), state));
                            }
                        }
                        return None;
                    }
                }
            }
        },
    ))
}

fn transform_direct_sse_stopless_control_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    policy: &V3DirectSseStoplessControlPolicy,
    committed_stopless_locator: &mut bool,
    state_transition_done: &mut bool,
) -> Result<Vec<Vec<u8>>, V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
    let mut output = Vec::with_capacity(frames.len());
    for frame in frames {
        let fields = transform_direct_sse_stopless_control_frame(
            frame.frame().fields(),
            policy,
            committed_stopless_locator,
            state_transition_done,
        )?;
        let decoded = build_v3_sse_transport_in_02_from_fields(fields)
            .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
        let validated = build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(decoded)
            .map_err(|error| runtime_source("V3ProviderResp14Raw", error))?;
        output.push(
            build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&validated).into_bytes(),
        );
    }
    Ok(output)
}

fn transform_direct_sse_stopless_control_frame(
    fields: &[SseField],
    policy: &V3DirectSseStoplessControlPolicy,
    committed_stopless_locator: &mut bool,
    state_transition_done: &mut bool,
) -> Result<Vec<SseField>, V3Error01SourceRaised> {
    let Some(request_state) = policy.request_stopless_state.as_ref() else {
        return Ok(fields.to_vec());
    };
    if !policy.stopless_center_enabled {
        return Ok(fields.to_vec());
    }
    let Some(scope) = policy.stopless_scope.as_ref() else {
        return Ok(fields.to_vec());
    };
    if !scope.has_client_session_scope() {
        return Ok(fields.to_vec());
    }
    let mut event_name = None::<String>;
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name == "event" && event_name.is_none() {
            event_name = Some(value.trim().to_string());
        } else if name == "data" {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value);
        }
    }
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(fields.to_vec());
    }
    let mut event: Value = serde_json::from_str(data).map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.to_string(),
        )
    })?;
    let semantic_event = event_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .or_else(|| event.get("type").and_then(Value::as_str))
        .unwrap_or_default();
    if direct_response_has_provider_tool_call(&event) {
        policy.clear_active_control_on_stream_terminal()?;
        *state_transition_done = true;
        return Ok(fields.to_vec());
    }
    if semantic_event != "response.completed" {
        return Ok(fields.to_vec());
    }
    let Some(response_payload) = event.get("response").cloned() else {
        return Ok(fields.to_vec());
    };
    let outcome = run_v3_responses_direct_stopless_response_hooks(
        response_payload,
        request_state,
        &policy.transition_request_id,
        policy.transition_updated_at,
        V3HubTransportIntent::Sse,
    )?;
    let intercepted = outcome.intercepted;
    let continue_remote = outcome
        .center_state
        .as_ref()
        .is_some_and(V3StoplessCenterState::need_continue);
    policy.apply_response_transition(outcome.center_state)?;
    *state_transition_done = true;
    if intercepted && continue_remote && !*committed_stopless_locator {
        policy.commit_stopless_remote_locator_for_payload(&outcome.payload)?;
        *committed_stopless_locator = true;
    }
    if !intercepted {
        return Ok(fields.to_vec());
    }
    if let Some(object) = event.as_object_mut() {
        object.insert("response".to_string(), outcome.payload);
    }
    let encoded_data = serde_json::to_string(&event).map_err(|error| {
        runtime_source("V3DirectStoplessResp03NoopCliOrTerminalProjected", error)
    })?;
    Ok(replace_sse_data_fields(fields, encoded_data))
}

fn replace_sse_data_fields(fields: &[SseField], data: String) -> Vec<SseField> {
    let mut replaced = false;
    let mut output = Vec::with_capacity(fields.len().max(1));
    for field in fields {
        match field {
            SseField::Named { name, .. } if name == "data" => {
                if !replaced {
                    output.push(SseField::Named {
                        name: "data".to_string(),
                        value: data.clone(),
                    });
                    replaced = true;
                }
            }
            other => output.push(other.clone()),
        }
    }
    if !replaced {
        output.push(SseField::Named {
            name: "data".to_string(),
            value: data,
        });
    }
    output
}

impl V3DirectSseStoplessControlPolicy {
    fn apply_response_transition(
        &self,
        response_state: Option<V3StoplessCenterState>,
    ) -> Result<(), V3Error01SourceRaised> {
        match response_state {
            Some(state) => {
                let Some(control) = self.stopless_control.as_ref() else {
                    return Ok(());
                };
                let Some(scope) = self.stopless_scope.as_ref() else {
                    return Ok(());
                };
                control.store_for_scope(scope, state).map_err(|error| {
                    runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error)
                })
            }
            None => self.clear_active_control_on_stream_terminal(),
        }
    }

    fn clear_active_control_on_stream_terminal(&self) -> Result<(), V3Error01SourceRaised> {
        if self.request_stopless_state.is_none() || !self.stopless_center_enabled {
            return Ok(());
        }
        let (Some(control), Some(scope)) =
            (self.stopless_control.as_ref(), self.stopless_scope.as_ref())
        else {
            return Ok(());
        };
        if !scope.has_client_session_scope() {
            return Ok(());
        }
        control
            .clear_for_scope(scope)
            .map_err(|error| runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error))
    }

    fn commit_stopless_remote_locator_for_payload(
        &self,
        payload: &Value,
    ) -> Result<(), V3Error01SourceRaised> {
        commit_v3_direct_stopless_remote_locator_for_payload(
            payload,
            self.previous_response_id.as_deref(),
            self.continuation_state.as_ref(),
            self.continuation_scope.as_ref(),
            &self.selected_pin,
            &self.selected_capability_revision,
            self.transition_updated_at,
        )
    }
}

impl V3DirectSseRemoteContinuationPolicy {
    fn commit_observed_pending(
        &mut self,
        observation_state: &V3SseRemoteContinuationObservationState,
    ) -> Result<(), V3Error01SourceRaised> {
        if self.committed_pending {
            return Ok(());
        }
        let Some(response_id) = observation_state
            .pending_response_id()
            .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?
        else {
            return Ok(());
        };
        let locator = V3RemoteContinuationLocator::new_direct(
            response_id,
            self.scope_key.clone(),
            self.selected_pin.clone(),
            self.selected_capability_revision.clone(),
            self.now_epoch_ms,
            self.now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
        );
        let input = V3RemoteContinuationCommitInput::locator_only(locator);
        let mut store = self
            .state
            .store
            .lock()
            .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
        let commit = match self.previous_response_id.as_deref() {
            Some(previous_response_id) => store.rebind_for_resp04(previous_response_id, input),
            None => store.commit(input),
        };
        commit.map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
        self.committed_pending = true;
        self.previous_response_id = None;
        Ok(())
    }

    fn release_terminal_previous(&mut self) -> Result<(), V3Error01SourceRaised> {
        if self.committed_pending {
            return Ok(());
        }
        let Some(previous_response_id) = self.previous_response_id.take() else {
            return Ok(());
        };
        let mut store = self
            .state
            .store
            .lock()
            .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
        if !store.release(&previous_response_id) {
            return Err(runtime_source(
                "V3HubRespContinuation04Committed",
                format!(
                    "terminal locator {previous_response_id} was not present at Resp04 release"
                ),
            ));
        }
        Ok(())
    }
}

fn capability_revision_for_pin(
    manifest: &V3Config05ManifestPublished,
    pin: &V3RemoteContinuationPin,
) -> Result<String, String> {
    let provider = manifest.providers.get(&pin.provider_id).ok_or_else(|| {
        format!(
            "provider {} is absent for capability revision",
            pin.provider_id
        )
    })?;
    let model = provider.models.get(&pin.model_id).ok_or_else(|| {
        format!(
            "provider {} model {} is absent for capability revision",
            pin.provider_id, pin.model_id
        )
    })?;
    Ok(format!(
        "provider={};type={};model={};wire={};capabilities={};streaming={};thinking={};thinking_mode={:?};max_tokens={:?};max_context_tokens={:?};provider_features={:?};model_features={:?}",
        provider.id,
        provider.provider_type,
        model.id,
        model.wire_name,
        model.capabilities.join(","),
        model.supports_streaming,
        model.supports_thinking,
        model.thinking,
        model.max_tokens,
        model.max_context_tokens,
        provider.features,
        model.features,
    ))
}

fn runtime_source(stage: &'static str, error: impl std::fmt::Display) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        stage,
        "v3_route_target_runtime_failure",
        error.to_string(),
    )
}

struct V3ExactPinAvailabilityExhaustion<'pin> {
    pin: &'pin V3RemoteContinuationPin,
    reason: String,
}

impl V3ExactPinAvailabilityExhaustion<'_> {
    fn decide_error_05(&self, hook_registry: &V3HookRegistry) -> V3Error05ExecutionDecision {
        let source = build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3HubReqTarget06Resolved",
            "continuation_exact_pin_unavailable",
            &self.reason,
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(503),
                code: Some("continuation_exact_pin_unavailable".to_string()),
                provider_id: Some(self.pin.provider_id.clone()),
                upstream_request_id: None,
                message: Some(self.reason.clone()),
            },
        );
        hook_registry.run_error(
            source,
            V3ErrorActionScope::CanonicalModel {
                provider_id: self.pin.provider_id.clone(),
                model_id: self.pin.model_id.clone(),
            },
            0,
            false,
            false,
            None,
        )
    }
}

async fn exact_pin_unavailable_output(
    provider_health: &V3ProviderFailureRuntimeHealth,
    server_id: &str,
    routing_group: &str,
    pin: &V3RemoteContinuationPin,
    previous_response_id: Option<&str>,
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    reason: String,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let proof = V3ExactPinAvailabilityExhaustion { pin, reason };
    let decision = proof.decide_error_05(hook_registry);
    let terminal = match decision.try_into_terminal() {
        Ok(terminal) => terminal,
        Err(decision) => {
            return error_output(
                runtime_source(
                    "V3Error05ExecutionDecision",
                    format!(
                        "exact-pin availability proof produced nonterminal {:?} Error05",
                        decision.action
                    ),
                ),
                node_trace,
                hook_registry,
            )
        }
    };
    match provider_health
        .wait_for_terminal_provider_projection(
            server_id,
            routing_group,
            &pin.provider_id,
            Some(&pin.auth_handle_id),
            Some(&pin.model_id),
            "continuation_exact_pin_unavailable",
        )
        .await
    {
        Ok(_) => {}
        Err(error) => {
            return error_output(
                runtime_source("V3ProviderActionGate", error),
                node_trace,
                hook_registry,
            )
        }
    }
    if let (Some(state), Some(response_id)) = (continuation_state, previous_response_id) {
        let release = state
            .store
            .lock()
            .map_err(|error| error.to_string())
            .map(|mut store| store.release(response_id));
        match release {
            Ok(true) => {}
            Ok(false) => {
                return error_output(
                    runtime_source(
                        "V3HubReqContinuation03Classified",
                        format!("terminal exact-pin locator {response_id} was not present"),
                    ),
                    node_trace,
                    hook_registry,
                )
            }
            Err(error) => {
                return error_output(
                    runtime_source("V3HubReqContinuation03Classified", error),
                    node_trace,
                    hook_registry,
                )
            }
        }
    }
    projected_error_output(
        build_v3_error_06_client_projected_from_v3_error_05(terminal),
        node_trace,
    )
}

fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let decision = hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None);
    let terminal = decision.try_into_terminal().unwrap_or_else(|decision| {
        panic!(
            "nonterminal {:?} Error05 reached generic Direct error projection",
            decision.action
        )
    });
    let projected = build_v3_error_06_client_projected_from_v3_error_05(terminal);
    projected_error_output(projected, node_trace)
}

fn projected_error_output(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
) -> V3ResponsesDirectRuntimeOutput {
    projected_error_output_with_observability(projected, node_trace, None)
}

fn projected_error_output_with_observability(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability,
        stream_observation: None,
        client_payload: V3Resp15ClientPayload {
            status: projected.status,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(projected.body),
        },
        node_trace,
        error_chain: Some(projected.chain.to_vec()),
        protocol_relay_handoff: None,
    }
}

fn relay_handoff_output(
    target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    node_trace: Vec<&'static str>,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability: None,
        stream_observation: None,
        client_payload: V3Resp15ClientPayload {
            status: 500,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(json!({
                "error": {
                    "code": "protocol_relay_handoff_unconsumed",
                    "message": "V3 Responses Direct selected a Relay-only provider; server must execute Hub Relay instead of projecting this internal handoff"
                }
            })),
        },
        node_trace: node_trace.clone(),
        error_chain: None,
        protocol_relay_handoff: Some(V3ResponsesProtocolRelayHandoff {
            target,
            node_trace,
            provider_failure_events,
        }),
    }
}

fn debug_error_output(
    stage: &'static str,
    error: V3DebugError,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    error_output(
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "v3_debug_failure",
            error.to_string(),
        ),
        vec![stage],
        hook_registry,
    )
}

fn client_payload_debug_value(payload: &V3Resp15ClientPayload) -> Value {
    match &payload.body {
        V3ClientBody::Json(value) => value.clone(),
        V3ClientBody::Bytes(bytes) => json!({
            "body_kind": "bytes",
            "byte_len": bytes.len()
        }),
        V3ClientBody::Sse(_) => json!({
            "body_kind": "sse_stream"
        }),
    }
}

struct V3RuntimeAttemptAvailability<'a, R> {
    base: &'a R,
    failed_candidates: &'a BTreeSet<String>,
}

impl<R: V3ProviderAvailabilityReader> V3ProviderAvailabilityReader
    for V3RuntimeAttemptAvailability<'_, R>
{
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
        let key = availability_key(provider_id, auth_alias, model_id);
        if self.failed_candidates.contains(&key) {
            projection.available = false;
            projection
                .blocked_scopes
                .push(format!("request_failed:{key}"));
        }
        projection
    }
}

fn candidate_key(candidate: &V3TargetCandidate) -> String {
    availability_key(
        &candidate.provider_id,
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

fn availability_key(provider_id: &str, auth_alias: Option<&str>, model_id: Option<&str>) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or(""),
        model_id.unwrap_or("")
    )
}

fn remaining_available_candidates<R: V3ProviderAvailabilityReader>(
    candidates: &[V3TargetCandidate],
    availability: &R,
    failed_candidates: &BTreeSet<String>,
) -> usize {
    let attempt_availability = V3RuntimeAttemptAvailability {
        base: availability,
        failed_candidates,
    };
    candidates
        .iter()
        .filter(|candidate| {
            attempt_availability
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    0,
                )
                .available
        })
        .count()
}

fn first_remaining_available_candidate_key<R: V3ProviderAvailabilityReader>(
    candidates: &[V3TargetCandidate],
    availability: &R,
    failed_candidates: &BTreeSet<String>,
) -> Option<String> {
    let attempt_availability = V3RuntimeAttemptAvailability {
        base: availability,
        failed_candidates,
    };
    candidates
        .iter()
        .find(|candidate| {
            attempt_availability
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    0,
                )
                .available
        })
        .map(candidate_key)
}

fn require_static_hooks(hook_registry: &V3HookRegistry) {
    for hook in [
        "ResponsesDirectRouteHook",
        "ResponsesDirectRequestProjectionHook",
        "ResponsesDirectProviderTransportHook",
        "ResponsesDirectResponseProjectionHook",
        "ResponsesDirectErrorHook",
    ] {
        assert!(
            hook_registry.require_hook(hook),
            "missing static hook {hook}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use routecodex_v3_config::*;
    use routecodex_v3_provider_responses::{
        V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw, V3ProviderResponseHeader,
        V3Transport13ResponsesHttpRequest,
    };
    use serde_json::json;
    use std::time::Duration;

    use crate::V3_PROVIDER_ACTION_ISOLATED_DELAY_MS;

    struct CaptureTransport;

    #[async_trait]
    impl ResponsesTransport for CaptureTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            assert_eq!(request.body(), &json!({"model":"gpt-test","input":"hello"}));
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_test","output_text":"ok"}"#.to_vec(),
            ))
        }
    }

    #[tokio::test]
    async fn runtime_executes_adjacent_responses_direct_chain() {
        let output = execute_v3_responses_direct_runtime_kernel(
            &test_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &CaptureTransport,
        )
        .await;
        assert_eq!(output.client_payload.status, 200, "{output:?}");
        let timing = output
            .observability
            .as_ref()
            .and_then(|observability| observability.timing)
            .expect("Direct JSON success must publish Runtime timing");
        assert_eq!(
            timing.internal.checked_add(timing.external),
            Some(timing.runtime_total)
        );
        match output.client_payload.body {
            V3ClientBody::Json(value) => {
                assert_eq!(value, json!({"id":"resp_test","output_text":"ok"}));
            }
            V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
                panic!("direct JSON response must remain JSON")
            }
        }
        assert_eq!(
            output.node_trace,
            vec![
                "V3Config05ManifestPublished",
                "V3Server03HttpRequestRaw",
                "V3Req04StandardizedResponses",
                "V3Router05RequestClassified",
                "V3Router06RoutePoolResolved",
                "V3Router07OpaqueTargetHitOnce",
                "V3Target08KindClassified",
                "V3Target09CandidateSetExpanded",
                "V3Target10ConcreteProviderSelected",
                "V3Execution11ProtocolDecision",
                "V3ResponsesDirect11Policy",
                "V3Provider12ResponsesWirePayload",
                "V3Transport13ResponsesHttpRequest",
                "V3ProviderResp14Raw",
                "V3DirectResp14ProviderProjectionPrepared",
                "V3DirectResp15ClientPayloadReady",
                "V3Resp15ClientPayload",
            ]
        );
    }

    fn scoped_test_manifest(
        mut manifest: V3Config05ManifestPublished,
        routing_group: &str,
    ) -> V3Config05ManifestPublished {
        let source_group_id = manifest
            .servers
            .get("test")
            .expect("test server")
            .routing_group
            .clone();
        let mut group = manifest
            .route_groups
            .get(&source_group_id)
            .expect("test route group")
            .clone();
        group.id = routing_group.to_string();
        manifest
            .route_groups
            .insert(routing_group.to_string(), group);
        manifest
            .servers
            .get_mut("test")
            .expect("test server")
            .routing_group = routing_group.to_string();
        manifest
    }

    fn test_direct_sse_provider_outcome(routing_group: &str) -> V3DirectSseProviderOutcome {
        let manifest = scoped_test_manifest(test_manifest(), routing_group);
        V3DirectSseProviderOutcome {
            provider_health: V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
            server_id: "test".to_string(),
            routing_group: routing_group.to_string(),
            provider_id: "openai".to_string(),
            auth_alias: "key1".to_string(),
            model_id: "gpt-test".to_string(),
            terminal: false,
            seen_done: false,
            recorded: false,
            _provider_action_permit: None,
        }
    }

    #[tokio::test]
    async fn direct_sse_runtime_timing_publishes_only_after_clean_eof() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
                .to_vec(),
        )]));
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_runtime_timing_clean_eof"),
            runtime_timing,
            observation.clone(),
        );

        while governed.next().await.is_some() {}

        let timing = observation
            .snapshot()
            .unwrap()
            .timing
            .expect("clean EOF must publish terminal Runtime timing");
        assert_eq!(
            timing.internal.checked_add(timing.external),
            Some(timing.runtime_total)
        );
    }

    #[tokio::test]
    async fn direct_sse_terminal_event_before_eof_does_not_publish_runtime_timing() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(
            stream::iter(vec![Ok(
                b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
                    .to_vec(),
            )])
            .chain(stream::pending()),
        );
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_terminal_before_eof"),
            runtime_timing,
            observation.clone(),
        );

        governed.next().await.unwrap().unwrap();
        assert!(
            observation.snapshot().unwrap().timing.is_none(),
            "terminal event without clean EOF must not publish Runtime timing"
        );
        drop(governed);
        assert!(observation.snapshot().unwrap().timing.is_none());
    }

    #[tokio::test]
    async fn direct_sse_malformed_tail_does_not_publish_runtime_timing() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\ndata: {"
                .to_vec(),
        )]));
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_malformed_tail"),
            runtime_timing,
            observation.clone(),
        );

        let mut saw_error = false;
        while let Some(result) = governed.next().await {
            if result.is_err() {
                saw_error = true;
            }
        }
        assert!(saw_error, "malformed SSE tail must fail closeout");
        assert!(
            observation.snapshot().unwrap().timing.is_none(),
            "malformed SSE tail must not publish successful Runtime timing"
        );
    }

    #[tokio::test]
    async fn direct_sse_response_done_without_completed_is_terminal_missing() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(stream::iter(vec![Ok(concat!(
            "event: response.done\n",
            "data: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\"}}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec())]));
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_done_without_completed"),
            runtime_timing,
            observation.clone(),
        );

        let mut error = None;
        while let Some(result) = governed.next().await {
            if let Err(source) = result {
                error = Some(source);
            }
        }
        let error = error.expect("response.done without response.completed must fail closeout");
        assert_eq!(error.code, "provider_response_sse_terminal_missing");
        assert!(error.message.contains("[DONE] without response.completed"));
        assert!(
            observation.snapshot().unwrap().timing.is_none(),
            "terminal-missing provider stream must not publish successful Runtime timing"
        );
    }

    #[tokio::test]
    async fn direct_sse_failed_event_without_error_code_is_protocol_invalid() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"quota exhausted\"}}}\n\n"
                .to_vec(),
        )]));
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_failed_missing_error_code"),
            runtime_timing,
            observation.clone(),
        );

        let error = governed
            .next()
            .await
            .expect("invalid failure event must terminate the stream")
            .expect_err("missing provider error.code must fail explicitly");
        assert_eq!(error.code, "provider_response_sse_event_invalid");
        assert!(error.message.contains("error.code"), "{}", error.message);
        assert!(observation.snapshot().unwrap().timing.is_none());
    }

    #[tokio::test]
    async fn direct_sse_incomplete_event_without_error_message_is_protocol_invalid() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"error\":{\"code\":\"HTTP_429\"}}}\n\n"
                .to_vec(),
        )]));
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_incomplete_missing_error_message"),
            runtime_timing,
            observation.clone(),
        );

        let error = governed
            .next()
            .await
            .expect("invalid incomplete event must terminate the stream")
            .expect_err("missing provider error.message must fail explicitly");
        assert_eq!(error.code, "provider_response_sse_event_invalid");
        assert!(error.message.contains("error.message"), "{}", error.message);
        assert!(observation.snapshot().unwrap().timing.is_none());
    }

    #[tokio::test]
    async fn direct_sse_failed_event_rejects_top_level_error_envelope() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"alternate envelope\"}}\n\n"
                .to_vec(),
        )]));
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_failed_top_level_error"),
            runtime_timing,
            observation.clone(),
        );

        let error = governed
            .next()
            .await
            .expect("alternate failure envelope must terminate the stream")
            .expect_err("top-level error must not replace response.error");
        assert_eq!(error.code, "provider_response_sse_event_invalid");
        assert!(
            error.message.contains("response object"),
            "{}",
            error.message
        );
        assert!(observation.snapshot().unwrap().timing.is_none());
    }

    #[tokio::test]
    async fn direct_sse_event_name_json_type_mismatch_is_protocol_invalid() {
        let runtime_timing = V3RuntimeTimingState::start();
        runtime_timing.start_external().unwrap();
        let observation = V3RuntimeStreamObservation::default();
        let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"quota exhausted\"}}}\n\n"
                .to_vec(),
        )]));
        let observed = wrap_direct_sse_provider_event_json_observation_stream(
            source,
            observation.clone(),
            runtime_timing.clone(),
        );
        let mut governed = wrap_direct_sse_provider_outcome_stream(
            observed,
            test_direct_sse_provider_outcome("direct_sse_event_type_mismatch"),
            runtime_timing,
            observation.clone(),
        );

        let mut error = None;
        while let Some(result) = governed.next().await {
            if let Err(source) = result {
                error = Some(source);
            }
        }
        let error = error.expect("mismatched SSE event and JSON type must fail");
        assert_eq!(error.code, "provider_response_sse_event_invalid");
        assert!(
            error.message.contains("does not match JSON type"),
            "{}",
            error.message
        );
        assert!(
            observation.snapshot().unwrap().timing.is_none(),
            "mismatched provider terminal semantics must not publish successful timing"
        );
    }

    #[tokio::test]
    async fn normal_direct_request_does_not_consume_unrelated_provider_failure_gate() {
        let routing_group = "normal_direct_bypasses_provider_action_gate";
        let manifest = scoped_test_manifest(test_manifest(), routing_group);
        let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        provider_health
            .record_provider_action_failure(
                "test",
                routing_group,
                "other-provider",
                Some("key1"),
                Some("other-model"),
                "provider_http_503",
            )
            .expect("seed unrelated provider failure gate");

        let output = tokio::time::timeout(
            Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS / 2),
            execute_v3_responses_direct_runtime_kernel(
                &manifest,
                V3Server03HttpRequestRaw {
                    server_id: "test".to_string(),
                    request_id: "req-normal-bypass-gate".to_string(),
                    execution_id: "exec".to_string(),
                    method: "POST".to_string(),
                    path: "/v1/responses".to_string(),
                    body: json!({"model":"client-model","input":"hello"}),
                },
                crate::register_responses_direct_hooks(),
                &CaptureTransport,
            ),
        )
        .await
        .expect("fresh normal request must not wait on unrelated group failure gate");

        assert_eq!(output.client_payload.status, 200, "{output:?}");
        assert!(
            !output
                .node_trace
                .contains(&"V3ProviderActionGateTerminalReevaluation"),
            "normal request must not re-evaluate terminal provider-action gate"
        );
        assert!(
            !output.node_trace.contains(&"V3ProviderActionGateAdmission"),
            "normal request must not consume provider-action gate admission"
        );

        provider_health
            .record_provider_success_in_scope(
                "test",
                routing_group,
                "other-provider",
                Some("key1"),
                Some("other-model"),
                0,
            )
            .expect("cleanup seeded provider failure gate");
    }

    #[tokio::test]
    async fn provider_error_enters_error_chain_not_success() {
        struct ErrorTransport;
        #[async_trait]
        impl ResponsesTransport for ErrorTransport {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                Err(V3ProviderError::Transport {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: "boom".to_string(),
                })
            }
        }
        let manifest = scoped_test_manifest(test_manifest(), "provider_error_terminal");
        let output = execute_v3_responses_direct_runtime_kernel(
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &ErrorTransport,
        )
        .await;
        assert_eq!(output.client_payload.status, 502);
        assert_eq!(output.error_chain.unwrap()[0], "V3Error01SourceRaised");
        match output.client_payload.body {
            V3ClientBody::Json(body) => {
                assert!(body["error"]["message"].as_str().unwrap().contains("boom"))
            }
            V3ClientBody::Bytes(_) => panic!("error response must be JSON"),
            V3ClientBody::Sse(_) => panic!("error response must be JSON"),
        }
    }

    #[tokio::test]
    async fn direct_runtime_rejects_routecodex_control_payload_before_provider_send() {
        struct NoSendTransport;
        #[async_trait]
        impl ResponsesTransport for NoSendTransport {
            async fn send(
                &self,
                _request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                panic!("side-channel control payload must fail before provider transport")
            }
        }

        let output = execute_v3_responses_direct_runtime_kernel(
            &test_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req-control-leak".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({
                    "model":"client-model",
                    "input":"hello",
                    "metadata": {"client": "kept"},
                    "metadataCenter": {"providerKey": "must-not-enter-body"}
                }),
            },
            crate::register_responses_direct_hooks(),
            &NoSendTransport,
        )
        .await;

        assert_eq!(output.client_payload.status, 500);
        assert!(output.node_trace.contains(&"V3Req04StandardizedResponses"));
        assert!(!output
            .node_trace
            .contains(&"V3Provider12ResponsesWirePayload"));
        match output.client_payload.body {
            V3ClientBody::Json(body) => {
                assert!(body["error"]["message"]
                    .as_str()
                    .expect("error message")
                    .contains("metadataCenter"));
            }
            V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => panic!("error response must be JSON"),
        }
    }

    #[tokio::test]
    async fn direct_runtime_rejects_invalid_current_data_image_before_provider_send() {
        struct NoSendTransport;
        #[async_trait]
        impl ResponsesTransport for NoSendTransport {
            async fn send(
                &self,
                _request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                panic!("invalid current-turn image must fail before provider transport")
            }
        }

        let output = execute_v3_responses_direct_runtime_kernel(
            &test_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req-invalid-image".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({
                    "model":"client-model",
                    "input":[{
                        "type":"message",
                        "role":"user",
                        "content":[
                            {"type":"input_text","text":"current turn"},
                            {"type":"input_image","image_url":"data:image/png;base64,AAAA"}
                        ]
                    }]
                }),
            },
            crate::register_responses_direct_hooks(),
            &NoSendTransport,
        )
        .await;

        assert_eq!(output.client_payload.status, 400);
        assert!(!output
            .node_trace
            .contains(&"V3Transport13ResponsesHttpRequest"));
        match output.client_payload.body {
            V3ClientBody::Json(body) => {
                assert_eq!(body["error"]["code"], "invalid_provider_request_payload");
                assert!(body["error"]["message"]
                    .as_str()
                    .expect("error message")
                    .contains("invalid data:image/png payload"));
            }
            V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => panic!("error response must be JSON"),
        }
    }

    #[tokio::test]
    async fn provider_failure_reselects_without_router_reentry() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        struct FirstFailsSecondSucceeds {
            sends: AtomicUsize,
            realtime_events: Arc<Mutex<Vec<String>>>,
            route_events: Arc<Mutex<Vec<String>>>,
        }

        #[async_trait]
        impl ResponsesTransport for FirstFailsSecondSucceeds {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                assert!(
                    !self.route_events.lock().unwrap().is_empty(),
                    "route selection event must be published before provider transport send"
                );
                if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(V3ProviderError::HttpStatus {
                        response: Box::new(V3ProviderHttpFailure {
                        request_id: request.request_id().to_string(),
                        provider_id: request.provider_id().to_string(),
                            status: 400,
                            headers: Vec::new(),
                            body: br#"{"error":{"code":"HTTP_400","message":"first provider rejected request"}}"#.to_vec(),
                        }),
                    });
                }
                assert_eq!(
                    self.realtime_events.lock().unwrap().as_slice(),
                    &["first:key:test".to_string()],
                    "provider failure event must be published before the next provider send"
                );
                assert_eq!(request.provider_id(), "second");
                assert_eq!(request.body()["model"], "wire-second");
                Ok(V3ProviderResp14Raw::from_json(
                    request.request_id(),
                    request.provider_id(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"application/json".to_vec(),
                    }],
                    br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
                ))
            }
        }

        let realtime_events = Arc::new(Mutex::new(Vec::<String>::new()));
        let route_events = Arc::new(Mutex::new(Vec::<String>::new()));
        let transport = FirstFailsSecondSucceeds {
            sends: AtomicUsize::new(0),
            realtime_events: Arc::clone(&realtime_events),
            route_events: Arc::clone(&route_events),
        };
        let manifest = scoped_test_manifest(reselection_manifest(), "provider_failure_reselection");
        let sink_events = Arc::clone(&realtime_events);
        let route_sink_events = Arc::clone(&route_events);
        let output = execute_v3_responses_direct_runtime_kernel_core(
            V3ResponsesDirectRuntimeCoreState::no_continuation()
                .with_provider_failure_event_sink(Some(Arc::new(move |_observability, event| {
                    sink_events.lock().unwrap().push(event.provider_key.clone());
                })))
                .with_route_selection_event_sink(Some(Arc::new(move |observability| {
                    route_sink_events
                        .lock()
                        .unwrap()
                        .push(observability.provider_key.clone().unwrap_or_default());
                }))),
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(output.client_payload.status, 200, "{output:?}");
        assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
        assert_eq!(route_events.lock().unwrap().len(), 2);
        assert_eq!(realtime_events.lock().unwrap().len(), 1);
        assert_eq!(
            output
                .node_trace
                .iter()
                .filter(|node| **node == "V3Router07OpaqueTargetHitOnce")
                .count(),
            1
        );
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
        let observability = output
            .observability
            .as_ref()
            .expect("Responses Direct must expose provider failure observability for V3 console");
        assert_eq!(observability.provider_id.as_deref(), Some("second"));
        assert_eq!(observability.provider_failure_events.len(), 1);
        assert_eq!(observability.provider_failure_events[0].status, 400);
        assert_eq!(
            observability.provider_failure_events[0]
                .external_error_kind
                .as_deref(),
            Some("provider")
        );
        assert_eq!(
            observability.provider_failure_events[0]
                .external_error_code
                .as_deref(),
            Some("HTTP_400")
        );
        assert_eq!(
            observability.provider_failure_events[0].external_error_status,
            Some(400)
        );
        assert_eq!(observability.provider_failure_events[0].internal_code, None);
        assert_eq!(
            observability.provider_failure_events[0]
                .next_provider_key
                .as_deref(),
            Some("second:key:test")
        );
    }

    #[tokio::test]
    async fn direct_reselect_to_cross_protocol_returns_relay_handoff_not_error06() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct FirstFailsSecondMustNotDirectSend {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for FirstFailsSecondMustNotDirectSend {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                assert_eq!(request.provider_id(), "first");
                self.sends.fetch_add(1, Ordering::SeqCst);
                Err(V3ProviderError::Transport {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: "first failed before relay-only candidate".to_string(),
                })
            }
        }

        let transport = FirstFailsSecondMustNotDirectSend {
            sends: AtomicUsize::new(0),
        };
        let manifest = scoped_test_manifest(
            mixed_protocol_reselection_manifest(),
            "cross_protocol_reselection",
        );
        let output = execute_v3_responses_direct_runtime_kernel(
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(transport.sends.load(Ordering::SeqCst), 1);
        assert_eq!(output.error_chain, None, "{output:?}");
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
        let handoff = output
            .protocol_relay_handoff
            .expect("cross-protocol reselect must hand off to Relay before Error06 projection");
        assert_eq!(handoff.target.candidate.provider_id, "chat");
        assert_eq!(handoff.target.candidate.provider_type, "openai_chat");
        assert_eq!(handoff.provider_failure_events.len(), 1);
        assert_eq!(
            handoff.provider_failure_events[0]
                .next_provider_key
                .as_deref(),
            Some("chat:key:test")
        );
        match output.client_payload.body {
            V3ClientBody::Json(value) => {
                assert_eq!(value["error"]["code"], "protocol_relay_handoff_unconsumed");
            }
            V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
                panic!("internal handoff placeholder must be JSON")
            }
        }
    }

    #[tokio::test]
    async fn provider_response_decode_failure_reselects_without_router_reentry() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct FirstMalformedSecondSucceeds {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for FirstMalformedSecondSucceeds {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
                    assert_eq!(request.provider_id(), "first");
                    return Ok(V3ProviderResp14Raw::from_json(
                        request.request_id(),
                        request.provider_id(),
                        200,
                        vec![V3ProviderResponseHeader {
                            name: "content-type".to_string(),
                            value: b"application/json".to_vec(),
                        }],
                        b"{\"id\":\"broken\"".to_vec(),
                    ));
                }
                assert_eq!(request.provider_id(), "second");
                assert_eq!(request.body()["model"], "wire-second");
                Ok(V3ProviderResp14Raw::from_json(
                    request.request_id(),
                    request.provider_id(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"application/json".to_vec(),
                    }],
                    br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
                ))
            }
        }

        let transport = FirstMalformedSecondSucceeds {
            sends: AtomicUsize::new(0),
        };
        let manifest = scoped_test_manifest(reselection_manifest(), "provider_decode_reselection");
        let output = execute_v3_responses_direct_runtime_kernel(
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(output.client_payload.status, 200, "{output:?}");
        assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
        assert_eq!(
            output
                .node_trace
                .iter()
                .filter(|node| **node == "V3Router07OpaqueTargetHitOnce")
                .count(),
            1
        );
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    }

    #[tokio::test]
    async fn provider_sse_failure_event_reselects_before_client_stream() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct FirstSseFailureSecondSucceeds {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for FirstSseFailureSecondSucceeds {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
                    assert_eq!(request.provider_id(), "first");
                    return Ok(V3ProviderResp14Raw::from_sse(
                        request.request_id().to_string(),
                        request.provider_id().to_string(),
                        200,
                        vec![V3ProviderResponseHeader {
                            name: "content-type".to_string(),
                            value: b"text/event-stream".to_vec(),
                        }],
                        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"first quota exhausted\"}}}\n\n".to_vec(),
                        )])),
                    ));
                }
                assert_eq!(request.provider_id(), "second");
                assert_eq!(request.body()["model"], "wire-second");
                Ok(V3ProviderResp14Raw::from_json(
                    request.request_id(),
                    request.provider_id(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"application/json".to_vec(),
                    }],
                    br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
                ))
            }
        }

        let transport = FirstSseFailureSecondSucceeds {
            sends: AtomicUsize::new(0),
        };
        let manifest =
            scoped_test_manifest(reselection_manifest(), "provider_sse_failure_reselection");
        let output = execute_v3_responses_direct_runtime_kernel(
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello","stream":true}),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(output.client_payload.status, 200, "{output:?}");
        assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
        match output.client_payload.body {
            V3ClientBody::Json(value) => assert_eq!(value["id"], "resp_second"),
            V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
                panic!("provider SSE failure must be reselected before client stream starts")
            }
        }
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
        let observability = output
            .observability
            .as_ref()
            .expect("provider SSE failure switch must be observable");
        assert_eq!(observability.provider_failure_events.len(), 1);
        assert_eq!(
            observability.provider_failure_events[0].message,
            "first quota exhausted"
        );
        assert_eq!(
            observability.provider_failure_events[0]
                .next_provider_key
                .as_deref(),
            Some("second:key:test")
        );
    }

    #[tokio::test]
    async fn matched_optional_failure_uses_captured_default_without_router_reentry() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct OptionalFailsDefaultSucceeds {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for OptionalFailsDefaultSucceeds {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                let attempt = self.sends.fetch_add(1, Ordering::SeqCst);
                if attempt == 0 {
                    assert_eq!(request.provider_id(), "optional");
                    return Err(V3ProviderError::Transport {
                        request_id: request.request_id().to_string(),
                        provider_id: request.provider_id().to_string(),
                        reason: "optional exhausted".to_string(),
                    });
                }
                assert_eq!(request.provider_id(), "default");
                assert_eq!(request.body()["model"], "wire-default");
                Ok(V3ProviderResp14Raw::from_json(
                    request.request_id(),
                    request.provider_id(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"application/json".to_vec(),
                    }],
                    br#"{"id":"resp_default","output_text":"ok"}"#.to_vec(),
                ))
            }
        }

        let transport = OptionalFailsDefaultSucceeds {
            sends: AtomicUsize::new(0),
        };
        let manifest = scoped_test_manifest(
            optional_default_manifest(),
            "matched_optional_default_reselection",
        );
        let output = execute_v3_responses_direct_runtime_kernel(
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({
                    "model": "client-model",
                    "input": "hello"
                }),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(output.client_payload.status, 200, "{output:?}");
        assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
        assert_eq!(
            output
                .node_trace
                .iter()
                .filter(|node| **node == "V3Router07OpaqueTargetHitOnce")
                .count(),
            1
        );
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    }

    #[tokio::test]
    async fn pinned_unavailable_provider_consumes_error05_gate_before_terminal_release() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{Duration, Instant};

        struct NoSendTransport {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for NoSendTransport {
            async fn send(
                &self,
                _request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                self.sends.fetch_add(1, Ordering::SeqCst);
                panic!("health-unavailable exact pin must never enter provider transport")
            }
        }

        let mut manifest = test_manifest();
        let gate_routing_group = "pinned_unavailable_provider_terminal_release";
        manifest.servers.get_mut("test").unwrap().routing_group = gate_routing_group.to_string();
        let continuation_state = V3ResponsesDirectContinuationState::default();
        let continuation_scope = V3ResponsesDirectContinuationScope::responses(
            "/v1/responses",
            "session-pinned-unavailable",
            "conversation-pinned-unavailable",
            4444,
            gate_routing_group,
        );
        let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let transport = NoSendTransport {
            sends: AtomicUsize::new(0),
        };
        let pin = V3RemoteContinuationPin::new("openai", "gpt-test", "key1");
        let capability_revision = capability_revision_for_pin(&manifest, &pin).unwrap();
        continuation_state
            .store
            .lock()
            .unwrap()
            .commit(V3RemoteContinuationCommitInput::locator_only(
                V3RemoteContinuationLocator::new_direct(
                    "resp_pinned_unavailable",
                    continuation_scope.key.clone(),
                    pin,
                    capability_revision,
                    1_000,
                    60_000,
                ),
            ))
            .unwrap();
        assert_eq!(continuation_state.len().unwrap(), 1);

        for failure_at in 2_000..2_003 {
            provider_health
                .record_provider_failure_record(
                    "openai",
                    Some("key1"),
                    Some("gpt-test"),
                    Some("controlled health failure"),
                    failure_at,
                )
                .unwrap();
        }
        let started = Instant::now();
        let terminal = execute_v3_responses_direct_runtime_kernel_core(
            V3ResponsesDirectRuntimeCoreState::with_continuation(
                &continuation_state,
                continuation_scope,
                2_001,
            )
            .with_provider_health(provider_health),
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req-pinned-unavailable-retry".to_string(),
                execution_id: "exec-pinned-unavailable-retry".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({
                    "model":"client-model",
                    "previous_response_id":"resp_pinned_unavailable",
                    "input":[{
                        "type":"function_call_output",
                        "call_id":"call_pinned_unavailable",
                        "output":"ok"
                    }]
                }),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(transport.sends.load(Ordering::SeqCst), 0);
        assert_eq!(
            terminal.error_chain.as_deref(),
            Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
        );
        assert!(
            started.elapsed() >= Duration::from_millis(6_000),
            "pinned health-unavailable path bypassed isolated 1s plus sustained 5s gates"
        );
        assert_eq!(
            continuation_state.len().unwrap(),
            0,
            "typed terminal Error05 must release only the matching continuation locator"
        );
        assert!(!terminal
            .node_trace
            .contains(&"V3Router07OpaqueTargetHitOnce"));
    }

    #[tokio::test]
    async fn missing_exact_pin_is_provider_availability_error05_without_router_reentry() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{Duration, Instant};

        struct NoSendTransport {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for NoSendTransport {
            async fn send(
                &self,
                _request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                self.sends.fetch_add(1, Ordering::SeqCst);
                panic!("missing exact pin must never enter provider transport")
            }
        }

        let mut manifest = test_manifest();
        manifest.servers.get_mut("test").unwrap().routing_group = "missing_exact_pin".to_string();
        let continuation_state = V3ResponsesDirectContinuationState::default();
        let continuation_scope = V3ResponsesDirectContinuationScope::responses(
            "/v1/responses",
            "session-missing-exact-pin",
            "conversation-missing-exact-pin",
            4444,
            "missing_exact_pin",
        );
        let pin = V3RemoteContinuationPin::new("openai", "gpt-test", "key1");
        let capability_revision = capability_revision_for_pin(&manifest, &pin).unwrap();
        continuation_state
            .store
            .lock()
            .unwrap()
            .commit(V3RemoteContinuationCommitInput::locator_only(
                V3RemoteContinuationLocator::new_direct(
                    "resp_missing_exact_pin",
                    continuation_scope.key.clone(),
                    pin,
                    capability_revision,
                    1_000,
                    60_000,
                ),
            ))
            .unwrap();
        manifest.providers.remove("openai");
        let transport = NoSendTransport {
            sends: AtomicUsize::new(0),
        };

        let started = Instant::now();
        let output = execute_v3_responses_direct_runtime_kernel_core(
            V3ResponsesDirectRuntimeCoreState::with_continuation(
                &continuation_state,
                continuation_scope,
                2_000,
            ),
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req-missing-exact-pin".to_string(),
                execution_id: "exec-missing-exact-pin".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({
                    "model":"client-model",
                    "previous_response_id":"resp_missing_exact_pin",
                    "input":[{
                        "type":"function_call_output",
                        "call_id":"call_missing_exact_pin",
                        "output":"ok"
                    }]
                }),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(transport.sends.load(Ordering::SeqCst), 0);
        assert!(
            started.elapsed() >= Duration::from_millis(1_000),
            "isolated exact-pin availability failure bypassed the Error05 action gate"
        );
        assert_eq!(
            output.error_chain.as_deref(),
            Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
        );
        match output.client_payload.body {
            V3ClientBody::Json(value) => {
                assert_eq!(value["error"]["code"], "continuation_exact_pin_unavailable");
                assert_eq!(
                    value.pointer("/error/external_error/kind"),
                    Some(&json!("provider"))
                );
            }
            V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
                panic!("missing exact pin must project typed terminal Error06 JSON")
            }
        }
        assert_eq!(
            continuation_state.len().unwrap(),
            0,
            "terminal exact-pin availability failure must release its locator"
        );
        assert!(!output.node_trace.contains(&"V3Router07OpaqueTargetHitOnce"));
    }

    #[tokio::test]
    async fn exact_pin_capability_revision_mismatch_stays_out_of_provider_failure_gate() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{Duration, Instant};

        struct NoSendTransport {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for NoSendTransport {
            async fn send(
                &self,
                _request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                self.sends.fetch_add(1, Ordering::SeqCst);
                panic!("capability revision mismatch must never enter provider transport")
            }
        }

        let manifest = test_manifest();
        let continuation_state = V3ResponsesDirectContinuationState::default();
        let continuation_scope = V3ResponsesDirectContinuationScope::responses(
            "/v1/responses",
            "session-revision-mismatch",
            "conversation-revision-mismatch",
            4444,
            "default",
        );
        continuation_state
            .store
            .lock()
            .unwrap()
            .commit(V3RemoteContinuationCommitInput::locator_only(
                V3RemoteContinuationLocator::new_direct(
                    "resp_revision_mismatch",
                    continuation_scope.key.clone(),
                    V3RemoteContinuationPin::new("openai", "gpt-test", "key1"),
                    "stale-capability-revision",
                    1_000,
                    60_000,
                ),
            ))
            .unwrap();
        let transport = NoSendTransport {
            sends: AtomicUsize::new(0),
        };

        let started = Instant::now();
        let output = execute_v3_responses_direct_runtime_kernel_core(
            V3ResponsesDirectRuntimeCoreState::with_continuation(
                &continuation_state,
                continuation_scope,
                2_000,
            ),
            &manifest,
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req-revision-mismatch".to_string(),
                execution_id: "exec-revision-mismatch".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({
                    "model":"client-model",
                    "previous_response_id":"resp_revision_mismatch",
                    "input":[{
                        "type":"function_call_output",
                        "call_id":"call_revision_mismatch",
                        "output":"ok"
                    }]
                }),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(transport.sends.load(Ordering::SeqCst), 0);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "continuation contract mismatch must not enter the provider action gate"
        );
        match output.client_payload.body {
            V3ClientBody::Json(value) => {
                assert_eq!(value["error"]["class"], "runtime_failure");
                assert_eq!(value["error"]["code"], "v3_route_target_runtime_failure");
                assert_ne!(
                    value["error"]["code"],
                    json!("continuation_exact_pin_unavailable")
                );
            }
            V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
                panic!("capability revision mismatch must project non-provider JSON error")
            }
        }
        assert!(!output.node_trace.contains(&"V3Router07OpaqueTargetHitOnce"));
    }

    fn test_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.openai]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }

[providers.openai.models.gpt-test]
supports_streaming = true
capabilities = ["text", "vision"]

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "openai", model = "gpt-test", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
        )
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    fn reselection_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "FIRST_KEY" }] }
[providers.first.models.test]
wire_name = "wire-first"

[providers.second]
type = "responses"
base_url = "http://second.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "SECOND_KEY" }] }
[providers.second.models.test]
wire_name = "wire-second"

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "second", model = "test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
        )
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    fn mixed_protocol_reselection_manifest() -> V3Config05ManifestPublished {
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

[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "FIRST_KEY" }] }
[providers.first.models.test]
wire_name = "wire-first"

[providers.chat]
type = "openai_chat"
base_url = "http://chat.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "CHAT_KEY" }] }
[providers.chat.models.test]
wire_name = "wire-chat"

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "chat", model = "test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
        )
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    fn optional_default_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.optional]
type = "responses"
base_url = "http://optional.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "OPTIONAL_KEY" }] }
	[providers.optional.models.test]
	wire_name = "wire-optional"
	capabilities = ["text", "tools"]

[providers.default]
type = "responses"
base_url = "http://default.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "DEFAULT_KEY" }] }
	[providers.default.models.test]
	wire_name = "wire-default"
	capabilities = ["text", "tools"]

[route_groups.default.pools.client_model]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-model"], min_input_tokens = 1, max_input_tokens = 100 }
targets = [{ kind = "provider_model", provider = "optional", model = "test", key = "key", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "default", model = "test", key = "key", priority = 1 }]
"#,
        )
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }
}
