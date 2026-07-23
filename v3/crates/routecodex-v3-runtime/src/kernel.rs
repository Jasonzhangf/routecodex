use crate::hooks::V3HookRegistry;
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
    V3ErrorActionScope, V3ErrorSourceKind, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderAvailabilityProjection,
    V3ProviderAvailabilityReader, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::remote_continuation::{
    V3RemoteContinuationCommitInput, V3RemoteContinuationLocator, V3RemoteContinuationPin,
    V3RemoteContinuationScopeKey, V3RemoteContinuationStore,
};
use crate::shared::{V3RemoteContinuationObservation, V3SseRemoteContinuationObservationState};

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

#[derive(Debug, Clone, Default)]
pub struct V3ResponsesDirectContinuationState {
    store: Arc<Mutex<V3RemoteContinuationStore>>,
}

impl V3ResponsesDirectContinuationState {
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
}

impl<'a> V3ResponsesDirectRuntimeCoreState<'a> {
    fn no_continuation() -> Self {
        Self {
            continuation_state: None,
            continuation_scope: None,
            now_epoch_ms: 0,
            provider_health: None,
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
        }
    }

    fn with_provider_health(mut self, provider_health: V3ProviderFailureRuntimeHealth) -> Self {
        self.provider_health = Some(provider_health);
        self
    }
}

#[derive(Debug)]
pub struct V3ResponsesDirectRuntimeOutput {
    pub client_payload: V3Resp15ClientPayload,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel(
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
    )
    .await
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_default_transport_and_debug(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_with_transport_and_debug(
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
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
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            state,
            continuation_scope,
            now_epoch_ms,
        ),
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
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            shared_state.continuation_state,
            continuation_scope,
            now_epoch_ms,
        )
        .with_provider_health(shared_state.provider_health),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_transport_and_debug<
    T: ResponsesTransport,
>(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
    debug: &V3DebugRuntime,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation(),
        manifest,
        raw,
        hook_registry,
        transport,
        debug,
    )
    .await
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
    let mut output = execute_v3_responses_direct_runtime_kernel_with_transport_and_debug(
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
    execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(state, scope, now_epoch_ms),
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
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    require_static_hooks(&hook_registry);
    let V3ResponsesDirectRuntimeCoreState {
        continuation_state,
        continuation_scope,
        now_epoch_ms,
        provider_health,
    } = state;

    let standardized = build_v3_req_04_standardized_responses_from_v3_server_03(raw);
    trace.push("V3Req04StandardizedResponses");
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

    let target = V3TargetInterpreter::default();
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
                return error_output(
                    runtime_source("V3HubReqTarget06Resolved", error),
                    trace,
                    &hook_registry,
                )
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
        if !availability
            .availability(
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                now_epoch_ms,
            )
            .available
        {
            return error_output(
                runtime_source("V3HubReqTarget06Resolved", "pinned provider unavailable"),
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
                request_capabilities: BTreeSet::new(),
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
    let expanded = if pinned_selected.is_none() {
        let routing_facts = build_v3_router_request_facts_from_v3_req_04(&standardized);
        let router = V3VirtualRouter::default();
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
    loop {
        let attempt_availability = V3RuntimeAttemptAvailability {
            base: &availability,
            failed_candidates: &failed_candidates,
        };
        let selected = match pinned_selected.take() {
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
        };
        if previous_response_id.is_none() {
            trace.push("V3Target10ConcreteProviderSelected");
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

        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(error) => {
                let source = build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3Transport13ResponsesHttpRequest",
                    "provider_transport_error",
                    error.to_string(),
                );
                if previous_response_id.is_some() {
                    if let Err(health_error) = record_v3_direct_provider_failure(
                        &provider_health,
                        &policy.target,
                        &source,
                        now_epoch_ms,
                    ) {
                        return error_output(health_error, trace, &hook_registry);
                    }
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
                    trace.push("V3HubRespContinuation04Committed");
                    return error_output(
                        build_v3_error_01_source_raised(
                            V3ErrorSourceKind::ProviderFailure,
                            "V3Transport13ResponsesHttpRequest",
                            "pinned_provider_transport_error",
                            source.message.clone(),
                        ),
                        trace,
                        &hook_registry,
                    );
                }
                match run_v3_direct_provider_failure_policy(
                    &provider_health,
                    &hook_registry,
                    &availability,
                    expanded.as_ref(),
                    &policy.target,
                    source,
                    &mut failed_candidates,
                    &mut same_candidate_retries,
                    now_epoch_ms,
                    &mut trace,
                )
                .await
                {
                    Ok(V3DirectProviderFailureDecision::Reselect) => continue,
                    Ok(V3DirectProviderFailureDecision::RetrySame(selected)) => {
                        retry_selected = Some(selected);
                        continue;
                    }
                    Ok(V3DirectProviderFailureDecision::Project(projected)) => {
                        return projected_error_output(projected, trace);
                    }
                    Err(source) => return error_output(source, trace, &hook_registry),
                }
            }
        };
        trace.push("V3ProviderResp14Raw");

        let mut response_projection =
            match hook_registry.run_response_projection(provider_raw).await {
                Ok(projection) => projection,
                Err(source) => {
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
                    if previous_response_id.is_some() {
                        if let Err(health_error) = record_v3_direct_provider_failure(
                            &provider_health,
                            &policy.target,
                            &source,
                            now_epoch_ms,
                        ) {
                            return error_output(health_error, trace, &hook_registry);
                        }
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
                        trace.push("V3HubRespContinuation04Committed");
                        return error_output(source, trace, &hook_registry);
                    }
                    match run_v3_direct_provider_failure_policy(
                        &provider_health,
                        &hook_registry,
                        &availability,
                        expanded.as_ref(),
                        &policy.target,
                        source,
                        &mut failed_candidates,
                        &mut same_candidate_retries,
                        now_epoch_ms,
                        &mut trace,
                    )
                    .await
                    {
                        Ok(V3DirectProviderFailureDecision::Reselect) => continue,
                        Ok(V3DirectProviderFailureDecision::RetrySame(selected)) => {
                            retry_selected = Some(selected);
                            continue;
                        }
                        Ok(V3DirectProviderFailureDecision::Project(projected)) => {
                            return projected_error_output(projected, trace);
                        }
                        Err(source) => return error_output(source, trace, &hook_registry),
                    }
                }
            };
        trace.push("V3DirectResp14ProviderProjectionPrepared");
        if let V3RemoteContinuationObservation::Streaming { state } =
            &response_projection.remote_continuation
        {
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
                            remote_capability_error: require_remote_continuation_capabilities(
                                manifest,
                                &selected_pin,
                            )
                            .err(),
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
            if let Err(source) =
                record_v3_direct_provider_success(&provider_health, &policy.target, now_epoch_ms)
            {
                return error_output(source, trace, &hook_registry);
            }
            trace.push("V3DirectResp15ClientPayloadReady");
            trace.push("V3Resp15ClientPayload");

            return V3ResponsesDirectRuntimeOutput {
                client_payload: response_projection.client_payload,
                node_trace: trace,
                error_chain: None,
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
                    if let Err(error) =
                        require_remote_continuation_capabilities(manifest, &selected_pin)
                    {
                        return error_output(
                            runtime_source("V3HubRespContinuation04Committed", error),
                            trace,
                            &hook_registry,
                        );
                    }
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
        if let Err(source) =
            record_v3_direct_provider_success(&provider_health, &policy.target, now_epoch_ms)
        {
            return error_output(source, trace, &hook_registry);
        }
        trace.push("V3DirectResp15ClientPayloadReady");
        trace.push("V3Resp15ClientPayload");

        return V3ResponsesDirectRuntimeOutput {
            client_payload: response_projection.client_payload,
            node_trace: trace,
            error_chain: None,
        };
    }
}

enum V3DirectProviderFailureDecision {
    Reselect,
    RetrySame(routecodex_v3_target::V3Target10ConcreteProviderSelected),
    Project(V3Error06ClientProjected),
}

fn record_v3_direct_provider_failure(
    provider_health: &V3ProviderFailureRuntimeHealth,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: &V3Error01SourceRaised,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    provider_health
        .record_provider_failure(
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            Some(&source.message),
            now_epoch_ms,
        )
        .map(|_| ())
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
    provider_health: &V3ProviderFailureRuntimeHealth,
    hook_registry: &V3HookRegistry,
    availability: &R,
    expanded: Option<&routecodex_v3_target::V3Target09CandidateSetExpanded>,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    failed_candidates: &mut BTreeSet<String>,
    same_candidate_retries: &mut BTreeMap<String, usize>,
    now_epoch_ms: u64,
    trace: &mut Vec<&'static str>,
) -> Result<V3DirectProviderFailureDecision, V3Error01SourceRaised> {
    record_v3_direct_provider_failure(provider_health, selected, &source, now_epoch_ms)?;

    let failed_key = candidate_key(&selected.candidate);
    let expanded_candidates = match expanded {
        Some(expanded) => &expanded.candidates,
        None => {
            return Err(runtime_source(
                "V3Target09CandidateSetExpanded",
                "routed candidate set missing",
            ))
        }
    };
    let mut failed_with_current = failed_candidates.clone();
    failed_with_current.insert(failed_key.clone());
    let remaining =
        remaining_available_candidates(expanded_candidates, availability, &failed_with_current);
    let provider_scope = V3ErrorActionScope::ProviderInstance {
        provider_id: selected.candidate.provider_id.clone(),
    };
    let projected = hook_registry.run_error(source, provider_scope, remaining);
    trace.extend(V3_ERROR_CHAIN_NODE_IDS);
    if projected
        .body
        .pointer("/error/decision")
        .and_then(Value::as_str)
        == Some("target_local_reselect")
    {
        failed_candidates.insert(failed_key);
        trace.push("V3TargetLocalReselected");
        return Ok(V3DirectProviderFailureDecision::Reselect);
    }
    if selected.default_floor_protected || selected.candidate.default_pool_member {
        let retries_done = same_candidate_retries.entry(failed_key).or_insert(0);
        if *retries_done < V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET {
            *retries_done = retries_done.saturating_add(1);
            trace.push("V3DefaultFloorBackoffWait");
            if V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS > 0 {
                tokio::time::sleep(Duration::from_millis(V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS))
                    .await;
            }
            return Ok(V3DirectProviderFailureDecision::RetrySame(selected.clone()));
        }
    }
    Ok(V3DirectProviderFailureDecision::Project(projected))
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
    remote_capability_error: Option<String>,
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
        if let Some(error) = self.remote_capability_error.clone() {
            return Err(runtime_source("V3HubRespContinuation04Committed", error));
        }
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

fn require_remote_continuation_capabilities(
    manifest: &V3Config05ManifestPublished,
    pin: &V3RemoteContinuationPin,
) -> Result<(), String> {
    let provider = manifest.providers.get(&pin.provider_id).ok_or_else(|| {
        format!(
            "provider {} is absent for remote continuation",
            pin.provider_id
        )
    })?;
    let model = provider.models.get(&pin.model_id).ok_or_else(|| {
        format!(
            "provider {} model {} is absent for remote continuation",
            pin.provider_id, pin.model_id
        )
    })?;
    for required in ["remote_continuation", "tool_outputs"] {
        if !model
            .capabilities
            .iter()
            .any(|capability| capability == required)
        {
            return Err(format!(
                "provider {} model {} lacks required {required} capability",
                pin.provider_id, pin.model_id
            ));
        }
    }
    Ok(())
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
    V3ResponsesDirectRuntimeOutput {
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
            crate::register_responses_direct_hooks(),
            &CaptureTransport,
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
                "V3ResponsesDirect11Policy",
                "V3Provider12ResponsesWirePayload",
                "V3Transport13ResponsesHttpRequest",
                "V3ProviderResp14Raw",
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

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "openai", model = "gpt-test", priority = 1 }]
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
model = "test"
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
