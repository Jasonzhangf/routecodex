use crate::hooks::{build_v3_provider_error_source, V3HookRegistry};
use crate::hub_v1::{
    apply_v3_stop_servertool_hook_at_resp03, apply_v3_stopless_request_hook_at_req04,
    apply_v3_tool_call_servertool_hook_at_resp03,
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
    select_v3_target_with_session_then_global,
    try_reselect_cross_session_revive_from_captured_candidates,
    v3_relay_provider_policy_now_epoch_ms, V3ProviderFailureRuntimeHealth,
    V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET,
};
use crate::remote_continuation::{
    V3RemoteContinuationCommitInput, V3RemoteContinuationLocator, V3RemoteContinuationPin,
    V3RemoteContinuationScopeKey, V3RemoteContinuationStore,
};
use crate::runtime_timing::{V3RuntimeObservabilityAccumulator, V3RuntimeTimingState};
use crate::shared::{V3RemoteContinuationObservation, V3SseRemoteContinuationObservationState};
use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime, V3DryRunFixture};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    V3Error01SourceRaised, V3Error05ExecutionAction, V3Error05ExecutionDecision,
    V3Error06ClientProjected, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
    V3ProviderFailureSessionScope, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderAvailabilityProjection,
    V3ProviderAvailabilityReader, V3ProviderError, V3ProviderFailureRecord, V3ProviderResp14Raw,
    V3ProviderResponseBodyKind, V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, build_v3_sse_transport_in_02_from_fields,
    build_v3_sse_transport_in_03_from_v3_sse_transport_in_02,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03, SseField, SseIncrementalDecoder,
    SseTransportLimits,
};
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

mod direct_sse_provider_outcome;
use direct_sse_provider_outcome::{
    wrap_direct_sse_provider_outcome_stream, V3DirectSseProviderOutcome,
};
const REMOTE_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;
static DEFAULT_RESPONSES_TRANSPORT: OnceLock<ReqwestResponsesTransport> = OnceLock::new();
fn default_responses_transport() -> &'static ReqwestResponsesTransport {
    DEFAULT_RESPONSES_TRANSPORT.get_or_init(ReqwestResponsesTransport::default)
}
include!("kernel/direct_state.rs");
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
    observability_accumulator: Option<V3RuntimeObservabilityAccumulator>,
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
        .with_initial_plan(initial_plan)
        .with_observability_accumulator(observability_accumulator),
        manifest,
        raw,
        hook_registry,
        default_responses_transport(),
        debug,
    )
    .await
}
include!("kernel/direct_protocol_plan.rs");
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
    let accumulator = state
        .observability_accumulator
        .clone()
        .unwrap_or_else(V3RuntimeObservabilityAccumulator::start);
    let runtime_timing = accumulator.timing();
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
        initial_request_local_excluded_candidates,
        initial_protocol_decision,
        initial_plan_trace,
        provider_health_neutral,
        provider_failure_event_sink,
        route_selection_event_sink,
        observability_accumulator: _,
    } = state;

    let mut standardized = match build_v3_req_04_standardized_responses_from_v3_server_03(raw) {
        Ok(standardized) => standardized,
        Err(error) => {
            trace.push("V3Req04StandardizedResponses");
            return error_output(
                runtime_source("V3Req04StandardizedResponses", error),
                trace,
                &hook_registry,
            );
        }
    };
    trace.push("V3Req04StandardizedResponses");
    if let Some(plan_trace) = initial_plan_trace {
        // Router05..Target09 already ran in the Server-side protocol plan;
        // splice those nodes so the client-visible trace stays identical to
        // the unplanned path without re-entering the Router.
        trace.extend(plan_trace);
    }
    let mut direct_stopless_control_prepared = false;
    let mut direct_stopless_request_state: Option<V3StoplessCenterState> = None;
    let previous_response_id = standardized.protocol_context.previous_response_id.clone();
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
    if let Err(message) = validate_initial_direct_plan(
        previous_response_id.is_some(),
        initial_selected_target.is_some(),
        initial_protocol_decision.is_some(),
    ) {
        trace.push("V3Execution11ProtocolDecision");
        return error_output(
            runtime_source("V3Execution11ProtocolDecision", message),
            trace,
            &hook_registry,
        );
    }
    let target = V3TargetInterpreter::default();
    let direct_failure_session_scope = match (&previous_response_id, continuation_scope.as_ref()) {
        (Some(_), Some(scope)) => match V3ProviderFailureSessionScope::new(
            &standardized.protocol_context.server_id,
            &scope.key.routing_group,
            &scope.key.session_id,
        ) {
            Ok(scope) => scope,
            Err(error) => {
                return error_output(
                    runtime_source("V3HubReqContinuation03Classified", error),
                    trace,
                    &hook_registry,
                )
            }
        },
        _ => standardized.protocol_context.failure_session_scope.clone(),
    };
    let provider_health =
        provider_health.unwrap_or_else(|| V3ProviderFailureRuntimeHealth::from_manifest(manifest));
    let availability = provider_health.session_bound_availability(&direct_failure_session_scope);
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
                    &direct_failure_session_scope,
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
    let mut failed_candidates = initial_request_local_excluded_candidates;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut initial_selected_target = initial_selected_target;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut send_attempts = 0usize;
    let mut pending_provider_action_recovery = None;
    let mut continuation_provider_action_lookup = previous_response_id.is_some();
    let mut pre_send_cross_session_revive_candidate = None::<String>;
    let allowed_modes =
        direct_runtime_allowed_execution_modes(manifest, &standardized.protocol_context.server_id);
    loop {
        let selected = match pinned_selected.take() {
            Some(selected) => selected,
            None => match initial_selected_target.take() {
                Some(selected) => selected,
                None => match retry_selected.take() {
                    Some(selected) => selected,
                    None => {
                        let captured_expanded = match expanded.as_ref() {
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
                        };
                        match select_v3_target_with_session_then_global(
                            &target,
                            captured_expanded.clone(),
                            &availability,
                            &provider_health,
                            &failed_candidates,
                            now_epoch_ms,
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                match try_reselect_cross_session_revive_from_captured_candidates(
                                    &provider_health,
                                    &direct_failure_session_scope,
                                    &captured_expanded,
                                    &failed_candidates,
                                    now_epoch_ms,
                                ) {
                                    Ok(Some(value)) => {
                                        pre_send_cross_session_revive_candidate =
                                            Some(candidate_key(&value.candidate));
                                        trace.push("V3CrossSessionReviveAdmitted");
                                        value
                                    }
                                    Ok(None) => {
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
                                    Err(error) => {
                                        return error_output(
                                            runtime_source("V3ProviderHealthStateMutated", error),
                                            trace,
                                            &hook_registry,
                                        )
                                    }
                                }
                            }
                        }
                    }
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
            let mut observability = build_v3_direct_runtime_observability(
                &selected,
                transport_label,
                None,
                "in_progress",
                provider_failure_events.clone(),
                false,
            );
            observability.attempts = Some(total_attempts(&accumulator, send_attempts));
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
                .wait_for_exact_selected_provider_action(&direct_failure_session_scope, &selected)
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
        let selected_candidate_key = candidate_key(&selected.candidate);
        let selected_available = v3_direct_selected_available_for_send(
            &selected,
            expanded.as_ref(),
            &availability,
            &provider_health,
            &failed_candidates,
            now_epoch_ms,
        );
        let mut selected_has_cross_session_revive =
            pre_send_cross_session_revive_candidate.take().as_deref()
                == Some(selected_candidate_key.as_str());
        if !selected_available && !selected_has_cross_session_revive {
            let mut failed_with_selected = failed_candidates.clone();
            failed_with_selected.insert(selected_candidate_key.clone());
            let remaining_after_selected = expanded.as_ref().map_or(0, |expanded| {
                remaining_available_candidates(
                    &expanded.candidates,
                    &availability,
                    &failed_with_selected,
                )
            });
            let globally_available = provider_health
                .availability(
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    now_epoch_ms,
                )
                .available;
            if globally_available && remaining_after_selected == 0 {
                selected_has_cross_session_revive =
                    match provider_health.store().try_acquire_cross_session_revive(
                        &direct_failure_session_scope,
                        &selected.candidate.provider_id,
                        Some(&selected.candidate.auth_alias),
                        Some(&selected.candidate.model_id),
                        now_epoch_ms,
                    ) {
                        Ok(admission) => admission.is_some(),
                        Err(error) => {
                            return error_output(
                                runtime_source("V3ProviderHealthStateMutated", error.to_string()),
                                trace,
                                &hook_registry,
                            )
                        }
                    };
            }
            if selected_has_cross_session_revive {
                trace.push("V3CrossSessionReviveAdmitted");
            }
        }
        if !selected_available && !selected_has_cross_session_revive {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3HubReqTarget06Resolved",
                "selected_provider_unavailable",
                "selected provider is unavailable",
            );
            drop(provider_action_permit.take());
            let policy_result = match run_v3_direct_provider_failure_policy(
                &V3DirectProviderFailurePolicyContext {
                    failure_session_scope: &direct_failure_session_scope,
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
                    total_attempts(&accumulator, send_attempts),
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
                    return projected_error_output_with_observability(
                        V3ErrorHandlingCenter::project_terminal(policy_result.decision),
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
            let captured_target_09 = match expanded.as_ref() {
                Some(expanded) => expanded.clone(),
                None => {
                    return error_output(
                        runtime_source(
                            "V3Target09CandidateSetExpanded",
                            "typed Relay handoff requires the captured Target09 candidate set",
                        ),
                        trace,
                        &hook_registry,
                    )
                }
            };
            return relay_handoff_output(
                decision.target,
                captured_target_09,
                failed_candidates.clone(),
                trace,
                provider_failure_events.clone(),
                accumulator.with_additional_attempts(send_attempts),
            );
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

        send_attempts = send_attempts.saturating_add(1);
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
                        failure_session_scope: &direct_failure_session_scope,
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
                        total_attempts(&accumulator, send_attempts),
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
                        let mut observability = build_v3_direct_runtime_observability(
                            &policy.target,
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                            false,
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        let projected =
                            V3ErrorHandlingCenter::project_terminal(policy_result.decision);
                        return projected_error_output_with_observability(
                            projected,
                            trace,
                            Some(observability),
                        );
                    }
                    V3Error05ExecutionAction::ClientDisconnected => {
                        return projected_error_output_with_observability(
                            V3ErrorHandlingCenter::project_terminal(policy_result.decision),
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
                            failure_session_scope: &direct_failure_session_scope,
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
                            total_attempts(&accumulator, send_attempts),
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
                            let mut observability = build_v3_direct_runtime_observability(
                                &policy.target,
                                "json",
                                policy_result.event.as_ref().map(|event| event.status),
                                "failed",
                                provider_failure_events.clone(),
                                false,
                            );
                            observability.attempts =
                                Some(total_attempts(&accumulator, send_attempts));
                            let projected =
                                V3ErrorHandlingCenter::project_terminal(policy_result.decision);
                            return projected_error_output_with_observability(
                                projected,
                                trace,
                                Some(observability),
                            );
                        }
                        V3Error05ExecutionAction::ClientDisconnected => {
                            return projected_error_output_with_observability(
                                V3ErrorHandlingCenter::project_terminal(policy_result.decision),
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
                            failure_session_scope: direct_failure_session_scope.clone(),
                            provider_id: policy.target.candidate.provider_id.clone(),
                            auth_alias: policy.target.candidate.auth_alias.clone(),
                            model_id: policy.target.candidate.model_id.clone(),
                            terminal: false,
                            seen_done: false,
                            recorded: false,
                            provider_health_neutral,
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

            let mut observability = build_v3_direct_runtime_observability(
                &policy.target,
                v3_direct_client_transport_label(&response_projection.client_payload),
                Some(provider_status),
                "streaming",
                provider_failure_events.clone(),
                direct_stopless_request_state.is_some(),
            );
            observability.attempts = Some(total_attempts(&accumulator, send_attempts));
            return V3ResponsesDirectRuntimeOutput {
                observability: Some(observability),
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
        if !provider_health_neutral {
            if let Err(source) = record_v3_direct_provider_success(
                &provider_health,
                &direct_failure_session_scope,
                &policy.target,
                now_epoch_ms,
            ) {
                return error_output(source, trace, &hook_registry);
            }
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
        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
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

include!("kernel/direct_stopless.rs");
include!("kernel/direct_runtime_helpers.rs");
#[cfg(test)]
mod tests;
