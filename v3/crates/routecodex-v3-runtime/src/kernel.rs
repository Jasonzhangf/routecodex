use crate::hooks::{build_v3_provider_error_source, V3HookRegistry};
use crate::hub_v1::{
    apply_v3_responses_direct_stopless_request_hook, V3RuntimeObservability,
    V3RuntimeProviderFailureObservation, V3RuntimeStreamObservation,
};
use crate::nodes::*;
use crate::provider_failure_runtime_policy::{
    V3ProviderFailureRuntimeHealth, V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS,
    V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET,
};
use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime, V3DryRunFixture};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader,
    V3ProviderError, V3ProviderFailureRecord, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::remote_continuation::{
    V3RemoteContinuationCommitInput, V3RemoteContinuationLocator, V3RemoteContinuationPin,
    V3RemoteContinuationScopeKey, V3RemoteContinuationStore,
};
use crate::shared::{V3RemoteContinuationObservation, V3SseRemoteContinuationObservationState};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
};

#[path = "direct_exec/mod.rs"]
mod direct_exec;

const REMOTE_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;

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
    provider_health: V3ProviderFailureRuntimeHealth,
}

impl<'a> V3ResponsesDirectRuntimeSharedState<'a> {
    pub fn new<H>(
        continuation_state: &'a V3ResponsesDirectContinuationState,
        provider_health: H,
    ) -> Self
    where
        H: Into<V3ProviderFailureRuntimeHealth>,
    {
        Self {
            continuation_state,
            provider_health: provider_health.into(),
        }
    }
}

#[derive(Clone)]
struct V3ResponsesDirectRuntimeCoreState<'a> {
    continuation_state: Option<&'a V3ResponsesDirectContinuationState>,
    continuation_scope: Option<V3ResponsesDirectContinuationScope>,
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
}

impl<'a> V3ResponsesDirectRuntimeCoreState<'a> {
    fn no_continuation() -> Self {
        Self {
            continuation_state: None,
            continuation_scope: None,
            now_epoch_ms: 0,
            provider_health: None,
            initial_selected_target: None,
            initial_expanded: None,
            initial_plan_trace: None,
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
            now_epoch_ms,
            provider_health: None,
            initial_selected_target: None,
            initial_expanded: None,
            initial_plan_trace: None,
        }
    }

    fn with_provider_health(mut self, provider_health: V3ProviderFailureRuntimeHealth) -> Self {
        self.provider_health = Some(provider_health);
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

pub struct V3ResponsesDirectExecutionEnv<'state, T: ResponsesTransport> {
    hook_registry: V3HookRegistry,
    transport: &'state T,
    debug: Option<&'state V3DebugRuntime>,
    core_state: V3ResponsesDirectRuntimeCoreState<'state>,
}

impl<'state, T: ResponsesTransport> V3ResponsesDirectExecutionEnv<'state, T> {
    pub fn new(hook_registry: V3HookRegistry, transport: &'state T) -> Self {
        Self {
            hook_registry,
            transport,
            debug: None,
            core_state: V3ResponsesDirectRuntimeCoreState::no_continuation(),
        }
    }

    pub fn with_debug(mut self, debug: &'state V3DebugRuntime) -> Self {
        self.debug = Some(debug);
        self
    }

    pub fn with_continuation(
        mut self,
        state: &'state V3ResponsesDirectContinuationState,
        scope: V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Self {
        self.core_state =
            V3ResponsesDirectRuntimeCoreState::with_continuation(state, scope, now_epoch_ms);
        self
    }

    pub fn with_shared_state_continuation(
        mut self,
        shared_state: V3ResponsesDirectRuntimeSharedState<'state>,
        scope: V3ResponsesDirectContinuationScope,
        now_epoch_ms: u64,
    ) -> Self {
        self.core_state = V3ResponsesDirectRuntimeCoreState::with_continuation(
            shared_state.continuation_state,
            scope,
            now_epoch_ms,
        )
        .with_provider_health(shared_state.provider_health);
        self
    }

    pub fn with_initial_plan(mut self, plan: &V3ResponsesProtocolExecutionPlan) -> Self {
        self.core_state = self.core_state.with_initial_plan(plan);
        self
    }
}

pub async fn execute_v3_responses_direct_runtime_kernel<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    env: V3ResponsesDirectExecutionEnv<'_, T>,
) -> V3ResponsesDirectRuntimeOutput {
    match env.debug {
        Some(debug) => {
            execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
                env.core_state,
                manifest,
                raw,
                env.hook_registry,
                env.transport,
                debug,
            )
            .await
        }
        None => {
            execute_v3_responses_direct_runtime_kernel_core(
                env.core_state,
                manifest,
                raw,
                env.hook_registry,
                env.transport,
            )
            .await
        }
    }
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
    let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized);
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

#[derive(Default)]
pub struct V3ResponsesDirectDryRunExecutionEnv<'plan> {
    initial_plan: Option<&'plan V3ResponsesProtocolExecutionPlan>,
}

impl<'plan> V3ResponsesDirectDryRunExecutionEnv<'plan> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_initial_plan(mut self, plan: &'plan V3ResponsesProtocolExecutionPlan) -> Self {
        self.initial_plan = Some(plan);
        self
    }
}

pub async fn execute_v3_responses_direct_dry_run_runtime(
    fixture: V3DryRunFixture,
    manifest: &V3Config05ManifestPublished,
    debug: &V3DebugRuntime,
    env: V3ResponsesDirectDryRunExecutionEnv<'_>,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_direct_dry_run_runtime_inner(fixture, manifest, debug, env.initial_plan)
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

async fn execute_v3_responses_direct_runtime_kernel_core<T: ResponsesTransport>(
    state: V3ResponsesDirectRuntimeCoreState<'_>,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    direct_exec::execute_v3_responses_direct_runtime_kernel_core_stages(
        state,
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await
}

enum V3DirectProviderFailureDecision {
    Reselect,
    RetrySame(Box<routecodex_v3_target::V3Target10ConcreteProviderSelected>),
    Project(Box<V3Error06ClientProjected>),
}

struct V3DirectProviderFailurePolicyResult {
    decision: V3DirectProviderFailureDecision,
    event: V3RuntimeProviderFailureObservation,
}

struct V3DirectProviderFailurePolicyContext<'ctx, R: V3ProviderAvailabilityReader + ?Sized> {
    provider_health: &'ctx V3ProviderFailureRuntimeHealth,
    hook_registry: &'ctx V3HookRegistry,
    availability: &'ctx R,
    expanded: Option<&'ctx routecodex_v3_target::V3Target09CandidateSetExpanded>,
    now_epoch_ms: u64,
}

struct V3DirectProviderFailurePolicyState<'state> {
    failed_candidates: &'state mut BTreeSet<String>,
    same_candidate_retries: &'state mut BTreeMap<String, usize>,
    trace: &'state mut Vec<&'static str>,
}

fn record_v3_direct_provider_failure(
    provider_health: &V3ProviderFailureRuntimeHealth,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: &V3Error01SourceRaised,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    record_v3_direct_provider_failure_record(provider_health, selected, source, now_epoch_ms)
        .map(|_| ())
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
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    provider_health
        .record_provider_success(
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
    let health_record = record_v3_direct_provider_failure_record(
        context.provider_health,
        selected,
        &source,
        context.now_epoch_ms,
    )?;

    let failed_key = candidate_key(&selected.candidate);
    let expanded_candidates = match context.expanded {
        Some(expanded) => &expanded.candidates,
        None => {
            return Err(runtime_source(
                "V3Target09CandidateSetExpanded",
                "routed candidate set missing",
            ))
        }
    };
    let mut failed_with_current = state.failed_candidates.clone();
    failed_with_current.insert(failed_key.clone());
    let remaining = remaining_available_candidates(
        expanded_candidates,
        context.availability,
        &failed_with_current,
    );
    let next_provider_key = first_remaining_available_candidate_key(
        expanded_candidates,
        context.availability,
        &failed_with_current,
    );
    let provider_scope = V3ErrorActionScope::ProviderInstance {
        provider_id: selected.candidate.provider_id.clone(),
    };
    let projected = context
        .hook_registry
        .run_error(source.clone(), provider_scope, remaining);
    state.trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    if projected
        .body
        .pointer("/error/decision")
        .and_then(Value::as_str)
        == Some("target_local_reselect")
    {
        state.failed_candidates.insert(failed_key);
        state.trace.push("V3TargetLocalReselected");
        return Ok(V3DirectProviderFailurePolicyResult {
            decision: V3DirectProviderFailureDecision::Reselect,
            event: build_v3_direct_provider_failure_observation(
                selected,
                status,
                &source,
                &health_record,
                "switch_provider",
                next_provider_key,
                None,
            ),
        });
    }
    if selected.default_floor_protected || selected.candidate.default_pool_member {
        let retries_done = state.same_candidate_retries.entry(failed_key).or_insert(0);
        if *retries_done < V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET {
            *retries_done = retries_done.saturating_add(1);
            state.trace.push("V3DefaultFloorBackoffWait");
            if V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS > 0 {
                tokio::time::sleep(Duration::from_millis(V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS))
                    .await;
            }
            return Ok(V3DirectProviderFailurePolicyResult {
                decision: V3DirectProviderFailureDecision::RetrySame(Box::new(selected.clone())),
                event: build_v3_direct_provider_failure_observation(
                    selected,
                    status,
                    &source,
                    &health_record,
                    "retry_provider",
                    Some(candidate_key(&selected.candidate)),
                    Some(V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS),
                ),
            });
        }
    }
    Ok(V3DirectProviderFailurePolicyResult {
        decision: V3DirectProviderFailureDecision::Project(Box::new(projected)),
        event: build_v3_direct_provider_failure_observation(
            selected,
            status,
            &source,
            &health_record,
            "terminal_default_floor_exhausted",
            None,
            None,
        ),
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
    V3RuntimeProviderFailureObservation {
        provider_key: candidate_key(&selected.candidate),
        provider_id: selected.candidate.provider_id.clone(),
        auth_alias: Some(selected.candidate.auth_alias.clone()),
        model_id: selected.candidate.model_id.clone(),
        status,
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
        stopless_activation: false,
        attempts: Some(selected.attempts),
        unavailable_candidates: selected.unavailable_candidates.clone(),
        provider_failure_events,
        target_path: selected.candidate.path.clone(),
        usage: None,
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

fn should_release_direct_locator_for_provider_failure(source: &V3Error01SourceRaised) -> bool {
    matches!(
        source.code.as_str(),
        "provider_http_400"
            | "provider_http_404"
            | "provider_http_500"
            | "provider_http_502"
            | "provider_http_503"
            | "provider_http_504"
            | "provider_response_sse_event_invalid"
            | "response.failed"
            | "response.incomplete"
            | "response.cancelled"
            | "response.canceled"
            | "response.error"
    )
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
) -> V3ClientSseStream {
    struct StreamState {
        source: V3ClientSseStream,
        decoder: SseIncrementalDecoder,
        stream_observation: V3RuntimeStreamObservation,
        done: bool,
    }

    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            stream_observation,
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
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        SseIncrementalDecoder::new(SseTransportLimits::default()),
                    );
                    match decoder
                        .finish()
                        .map_err(|error| runtime_source("V3ProviderResp14Raw", error))
                    {
                        Ok(()) => None,
                        Err(error) => {
                            state.done = true;
                            Some((Err(error), state))
                        }
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

fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let projected = hook_registry.run_error(source, V3ErrorActionScope::None, 0);
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
        V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
        V3Transport13ResponsesHttpRequest,
    };
    use serde_json::json;

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
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &CaptureTransport,
            ),
        )
        .await;
        assert_eq!(output.client_payload.status, 200);
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
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &ErrorTransport,
            ),
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
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &NoSendTransport,
            ),
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
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &NoSendTransport,
            ),
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

        struct FirstFailsSecondSucceeds {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for FirstFailsSecondSucceeds {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(V3ProviderError::Transport {
                        request_id: request.request_id().to_string(),
                        provider_id: request.provider_id().to_string(),
                        reason: "first failed".to_string(),
                    });
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

        let transport = FirstFailsSecondSucceeds {
            sends: AtomicUsize::new(0),
        };
        let output = execute_v3_responses_direct_runtime_kernel(
            &reselection_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &transport,
            ),
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
        let observability = output
            .observability
            .as_ref()
            .expect("Responses Direct must expose provider failure observability for V3 console");
        assert_eq!(observability.provider_id.as_deref(), Some("second"));
        assert_eq!(observability.provider_failure_events.len(), 1);
        assert_eq!(
            observability.provider_failure_events[0]
                .external_error_kind
                .as_deref(),
            Some("transport")
        );
        assert_eq!(
            observability.provider_failure_events[0]
                .external_error_code
                .as_deref(),
            Some("TRANSPORT_ERROR")
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
        let output = execute_v3_responses_direct_runtime_kernel(
            &reselection_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &transport,
            ),
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
        let output = execute_v3_responses_direct_runtime_kernel(
            &reselection_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello","stream":true}),
            },
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &transport,
            ),
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
        let output = execute_v3_responses_direct_runtime_kernel(
            &optional_default_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({
                    "model": "client-model",
                    "input": "hello",
                    "tools": [{"type":"function","name":"run","parameters":{"type":"object"}}]
                }),
            },
            V3ResponsesDirectExecutionEnv::new(
                crate::register_responses_direct_hooks(),
                &transport,
            ),
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

[route_groups.default.pools.tools]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-model"], required_capabilities = ["tools"], min_input_tokens = 1, max_input_tokens = 100 }
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
