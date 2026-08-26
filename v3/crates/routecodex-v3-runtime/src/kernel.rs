use crate::hooks::{build_v3_provider_error_source, V3HookRegistry};
use crate::hub_v1::{
    apply_v3_stop_servertool_hook_at_resp03, apply_v3_stopless_request_hook_at_req04,
    apply_v3_tool_call_servertool_hook_at_resp03,
    build_provider_resp_compat_02_from_v3_provider_resp_inbound_01,
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02,
    build_v3_provider_resp_inbound_01_raw_with_compat_profile, record_v3_provider_sse_json_frame,
    v3_responses_direct_stopless_center_enabled_for_server, V3HubContinuationOwnership,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRelayRequestHookEvent, V3HubRelayResponseHookProfile, V3HubTransportIntent,
    V3ProviderRespInbound01RawContext, V3RuntimeObservability, V3RuntimeProviderFailureEventSink,
    V3RuntimeProviderFailureObservation, V3RuntimeRouteSelectionEventSink,
    V3RuntimeStreamObservation, V3ServerToolCenterWriteOrigin, V3StoplessCenterState,
};
use crate::nodes::*;
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    build_v3_transient_failure_record, build_v3_transient_recovery_witness,
    select_v3_expanded_target_with_exhaustion_rescue, select_v3_target_with_session_then_global,
    V3ProviderFailureRuntimeHealth, V3TargetSelectionAfterRescue, V3_TRANSIENT_RETRY_BUDGET,
};
use crate::remote_continuation::{
    V3RemoteContinuationCommitInput, V3RemoteContinuationLocator, V3RemoteContinuationPin,
    V3RemoteContinuationScopeKey, V3RemoteContinuationStore,
};
use crate::runtime_timing::{V3RuntimeObservabilityAccumulator, V3RuntimeTimingState};
use crate::shared::{
    V3ProviderAttemptBody, V3RemoteContinuationObservation, V3SseRemoteContinuationObservationState,
};
use crate::sse_object_pipeline::process_sse_object_frame;
use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime, V3DryRunFixture};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    is_v3_retryable_transient_source, V3Error01SourceRaised, V3Error05ExecutionAction,
    V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3ProviderFailureSessionScope,
    V3_ERROR_CHAIN_NODE_IDS, V3_TRANSIENT_TRANSPORT_HANG_CODE,
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
    SseTransportIn02DecodedFrame, SseTransportIn03ValidatedFrameStream, SseTransportLimits,
};
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};

pub mod direct_request_key_hooks;
mod direct_runtime_helpers_stream;
pub(crate) use direct_runtime_helpers_stream::wrap_direct_sse_provider_event_json_observation_stream_with_compat as wrap_direct_sse_provider_event_json_observation_stream_with_compat_hook;
mod direct_sse_consumers;
pub(crate) use direct_sse_consumers::V3DirectSseTypedHookCatalog;
mod v3_direct_protocol_codec;
pub use v3_direct_protocol_codec::{
    V3ChatDirectCodec, V3DirectProtocolCodec, V3ResponsesDirectCodec,
};
const REMOTE_CONTINUATION_TTL_MS: u64 = 30 * 60 * 1_000;

/// 挂起判定的固定 reason：只有响应头等待超时构造的 Transport 错误才进入
/// health-neutral 瞬态重试；其余 transport 错误（连接失败等）保持原策略。
const V3_DIRECT_TRANSPORT_HANG_REASON: &str = "provider response header timed out (suspected hang)";

fn responses_direct_transport_response_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> std::time::Duration {
    crate::hub_v1::v3_relay_transport_response_timeout(manifest, provider_id)
}

static DEFAULT_RESPONSES_TRANSPORT: OnceLock<ReqwestResponsesTransport> = OnceLock::new();
pub fn default_responses_transport() -> &'static ReqwestResponsesTransport {
    DEFAULT_RESPONSES_TRANSPORT.get_or_init(ReqwestResponsesTransport::default)
}

pub fn default_provider_transport_handoff_checkpoints(
) -> Vec<routecodex_v3_provider_responses::V3ProviderTransportCheckpoint> {
    default_responses_transport()
        .transport_handoff_broker()
        .checkpoints()
}

pub fn restore_default_provider_transport_handoff_checkpoints(
    checkpoints: &[routecodex_v3_provider_responses::V3ProviderTransportCheckpoint],
) -> Result<usize, String> {
    default_responses_transport()
        .transport_handoff_broker()
        .restore_detached(checkpoints)
}
include!("kernel/direct_kernel_entrypoints.rs");
include!("kernel/direct_state.rs");
async fn execute_v3_responses_direct_runtime_kernel_core<T: ResponsesTransport + ?Sized>(
    state: V3ResponsesDirectRuntimeCoreState,
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    let raw_for_sse_handoff = raw.clone();
    let manifest_for_sse_handoff = manifest.clone();
    let state_for_sse_handoff = state.clone();
    let hook_registry_for_sse_handoff = hook_registry;
    let transport_for_sse_handoff = transport.handoff_handle();
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
        allow_exhaustion_rescue_probe,
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
    let previous_response_id = standardized
        .body
        .get("previous_response_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let continuation_disabled = crate::shared::v3_responses_continuation_disabled_for_server(
        manifest,
        &standardized.server_id,
    );
    let pinned = match (
        &previous_response_id,
        continuation_state.as_ref(),
        continuation_scope.as_ref(),
    ) {
        (Some(_), _, _) if continuation_disabled => {
            return error_output(
                runtime_source(
                    "V3HubReqContinuation03Classified",
                    "responses continuation disabled: previous_response_id restore rejected",
                ),
                trace,
                &hook_registry,
            )
        }
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
            &standardized.server_id,
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
        _ => standardized.failure_session_scope.clone(),
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
                    continuation_scope.as_ref(),
                    previous_response_id.as_deref(),
                    continuation_state.as_deref(),
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
                server_id: standardized.server_id.clone(),
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
    let route_policy_state = crate::route_policy::V3RoutePolicyRuntimeState::process_shared();
    let mut route_policy_scope = match continuation_scope.as_ref() {
        Some(scope) => crate::route_policy::V3RoutePolicyScope::without_conversation(
            &standardized.server_id,
            &scope.key.routing_group,
            direct_failure_session_scope.session_id(),
            scope.key.port.to_string(),
        )
        .with_conversation(scope.key.conversation_id.clone()),
        None => crate::route_policy::V3RoutePolicyScope::without_conversation(
            &standardized.server_id,
            direct_failure_session_scope.routing_group(),
            direct_failure_session_scope.session_id(),
            &standardized.server_id,
        )
        .with_conversation(direct_failure_session_scope.session_id()),
    };
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
            &standardized.server_id,
            &standardized.endpoint,
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
        route_policy_scope.routing_group_id = classified.routing_group_id.clone();
        let route_policy_observation = crate::route_policy::observe_route_turn(
            &standardized.body,
            &classified.facts.route_classification.route_name,
        );
        let classified = match route_policy_state.evaluate_request(
            manifest,
            classified,
            route_policy_scope.clone(),
            &standardized.request_id,
            route_policy_observation,
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
        let request_is_compaction = standardized.request_purpose.is_compaction()
            || standardized
                .endpoint
                .trim_end_matches('/')
                .ends_with("/responses/compact");
        let classified = if request_is_compaction {
            V3VirtualRouter::with_route_policy_pool(classified, Some("compact".to_string()))
        } else {
            classified
        };
        trace.push("V3Router05RequestClassified");
        let plan = match router.resolve_route_pool_plan(manifest, classified) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    crate::shared::v3_route_plan_error_source(
                        "V3Router06RoutePoolResolved",
                        "v3_route_target_runtime_failure",
                        error,
                    ),
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
    let route_policy_policies = match crate::route_policy::compile_route_policies(
        manifest,
        &route_policy_scope.routing_group_id,
    ) {
        Ok(policies) => policies,
        Err(error) => {
            return error_output(
                runtime_source("V3Router05RequestClassified", error),
                trace,
                &hook_registry,
            )
        }
    };
    let standardized_request_id = standardized.request_id.clone();
    let standardized_server_id = standardized.server_id.clone();
    let commit_route_policy = || -> Result<(), String> {
        route_policy_state.commit_request(
            &route_policy_scope,
            &standardized_request_id,
            &route_policy_policies,
        )
    };
    let mut failed_candidates = initial_request_local_excluded_candidates;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut initial_selected_target = initial_selected_target;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut send_attempts = 0usize;
    let mut pending_provider_action_recovery = None;
    let mut continuation_provider_action_lookup = previous_response_id.is_some();
    let allowed_modes = direct_runtime_allowed_execution_modes(manifest, &standardized.server_id);
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
                        match select_v3_expanded_target_with_exhaustion_rescue(
                            manifest,
                            captured_expanded.clone(),
                            &direct_failure_session_scope,
                            &provider_health,
                            &failed_candidates,
                            now_epoch_ms,
                            0,
                            allow_exhaustion_rescue_probe,
                        )
                        .await
                        {
                            V3TargetSelectionAfterRescue::Selected(value) => value,
                            V3TargetSelectionAfterRescue::Failed(source) => {
                                return error_output(source, trace, &hook_registry)
                            }
                            V3TargetSelectionAfterRescue::Exhausted(error) => {
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
                        }
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
                "responses",
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
                Ok(V3ProviderActionRecoveryTransition::Consumed(_)) => {
                    pending_provider_action_recovery = None;
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateConsumedReevaluation");
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
        let selected_available = v3_direct_selected_available_for_send(
            &selected,
            expanded.as_ref(),
            &availability,
            &provider_health,
            &failed_candidates,
            now_epoch_ms,
        );
        if !selected_available {
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
                    run_error: crate::hooks::responses_direct_error_hook,
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
                    "responses",
                    "json",
                    Some(event.status),
                    &provider_failure_events,
                    &event,
                    total_attempts(&accumulator, send_attempts),
                );
            }
            match &policy_result.decision.action {
                V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                    if policy_result.retryable_transient {
                        // 瞬态失败切走：request-local witness 不经过
                        // provider action gate（无 lane 可等），立即重选。
                        continue;
                    }
                    pending_provider_action_recovery = Some(recovery.clone());
                    continue;
                }
                V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                    retry_selected = policy_result.retry_selected.map(|selected| *selected);
                    if policy_result.retryable_transient {
                        // 瞬态失败重试同一 provider：不经过 provider action
                        // gate（无 lane 可等），立即重发。
                        continue;
                    }
                    pending_provider_action_recovery = Some(recovery.clone());
                    continue;
                }
                V3Error05ExecutionAction::ProjectTerminal => {
                    if let Err(error) = release_terminal_failure_locator(
                        continuation_state.as_deref(),
                        continuation_scope.as_ref(),
                        previous_response_id.as_deref(),
                        &selected_pin,
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
                &standardized.server_id,
                stopless_control.as_deref(),
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
                &standardized.server_id,
                stopless_control.as_deref(),
                stopless_scope.as_ref(),
                &mut standardized.body,
                &standardized.request_id,
                now_epoch_ms,
                &mut trace,
            ) {
                Ok(state) => {
                    direct_stopless_request_state = state;
                    direct_stopless_control_prepared = true;
                }
                Err(source) => return error_output(source, trace, &hook_registry),
            }
            // direct websearch：独立于 stopless center 开关的 Req04 工具面
            // 决策（Mode B 本地化 + 激活登记）与下一轮配对收尾。
            match prepare_v3_responses_direct_web_search_control_request(
                manifest,
                stopless_control.as_deref(),
                stopless_scope.as_ref(),
                &mut standardized.body,
                &mut trace,
            ) {
                Ok(()) => {}
                Err(source) => return error_output(source, trace, &hook_registry),
            }
            if let Err(source) = apply_v3_responses_direct_web_search_control_completion(
                stopless_control.as_deref(),
                stopless_scope.as_ref(),
                &standardized.body,
                &mut trace,
            ) {
                return error_output(source, trace, &hook_registry);
            }
        }

        // Responses direct has a protocol-specific kernel, so it must enter the
        // same Req04 tool-thinking hook explicitly as the generic direct kernel.
        // Keep the injection owner in the shared Req04 hook; this call only wires
        // the direct lifecycle edge before policy and provider wire projection.
        if let Err(source) =
            crate::kernel::v3_direct_protocol_codec::V3ResponsesDirectCodec::prepare_before_send(
                &mut (),
                manifest,
                &standardized_server_id,
                &mut standardized,
                &standardized_request_id,
                now_epoch_ms,
                &mut trace,
            )
        {
            return error_output(source, trace, &hook_registry);
        }

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
                    continuation_state.as_deref(),
                    continuation_scope.as_ref(),
                    previous_response_id.as_deref(),
                    &selected_pin,
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
                    continuation_state.as_deref(),
                    continuation_scope.as_ref(),
                    previous_response_id.as_deref(),
                    &selected_pin,
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
        let handoff_scope = match (
            standardized.pipeline_id.clone(),
            standardized.port,
            standardized
                .failure_session_scope
                .transport_handoff_scope()
                .map(|(_, _, generation)| generation),
        ) {
            (Some(pipeline_id), Some(port), Some(runtime_generation)) => {
                routecodex_v3_provider_responses::V3ProviderTransportHandoffScope {
                    pipeline_id,
                    server_id: standardized.server_id.clone(),
                    port,
                    session_scope: format!(
                        "{}:{}:{}",
                        standardized.failure_session_scope.server_id(),
                        standardized.failure_session_scope.routing_group(),
                        standardized.failure_session_scope.session_id()
                    ),
                    runtime_generation,
                }
            }
            _ => {
                return error_output(
                    runtime_source(
                        "V3Transport13ResponsesHttpRequest",
                        "provider transport handoff scope is missing",
                    ),
                    trace,
                    &hook_registry,
                )
            }
        };
        let transport_request = match transport_request.with_handoff_scope(handoff_scope) {
            Ok(request) => request,
            Err(error) => {
                return error_output(
                    runtime_source("V3Transport13ResponsesHttpRequest", error),
                    trace,
                    &hook_registry,
                )
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
        let provider_raw = match tokio::time::timeout(
            responses_direct_transport_response_timeout(
                manifest,
                &policy.target.candidate.provider_id,
            ),
            transport.send(transport_request),
        )
        .await
        .unwrap_or_else(|_elapsed| {
            // provider 挂起（响应头等待超时）：归一化为 transport 错误进入错误链
            // （reselect 切 provider + health 记录 + 3 次拉黑 15 分钟），避免客户端
            // 无限重试命中同一挂起 provider；错误只反映 provider 行为。
            Err(V3ProviderError::Transport {
                request_id: standardized.request_id.clone(),
                provider_id: policy.target.candidate.provider_id.clone(),
                reason: V3_DIRECT_TRANSPORT_HANG_REASON.to_string(),
            })
        }) {
            Ok(raw) => raw,
            Err(error) => {
                if let Err(timing_error) = runtime_timing.finish_external() {
                    return error_output(
                        runtime_source("V3RuntimeTimingExternal", timing_error),
                        trace,
                        &hook_registry,
                    );
                }
                let hang = matches!(
                    &error,
                    V3ProviderError::Transport { reason, .. }
                        if reason == V3_DIRECT_TRANSPORT_HANG_REASON
                );
                let source =
                    build_v3_provider_error_source("V3Transport13ResponsesHttpRequest", error);
                // 挂起由错误处理中心按「transport 阶段 + 专属 code」判定为瞬态
                // （health-neutral 重试 3 次），不在构造处打标记。
                let source = if hang {
                    let mut source = source;
                    source.code = V3_TRANSIENT_TRANSPORT_HANG_CODE.to_string();
                    source
                } else {
                    source
                };
                drop(provider_action_permit.take());
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        failure_session_scope: &direct_failure_session_scope,
                        provider_health: &provider_health,
                        run_error: crate::hooks::responses_direct_error_hook,
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
                        "responses",
                        "json",
                        Some(event.status),
                        &provider_failure_events,
                        &event,
                        total_attempts(&accumulator, send_attempts),
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        if policy_result.retryable_transient {
                            // 瞬态失败切走：不经过 provider action gate，立即重选。
                            continue;
                        }
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        if policy_result.retryable_transient {
                            // 瞬态失败重试同一 provider：不经过 provider action
                            // gate（无 health 记录可等），立即重发。
                            continue;
                        }
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::ProjectTerminal => {
                        if let Err(release_error) = release_terminal_failure_locator(
                            continuation_state.as_deref(),
                            continuation_scope.as_ref(),
                            previous_response_id.as_deref(),
                            &selected_pin,
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
                            "responses",
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

        let direct_response_compat_context =
            match crate::kernel::v3_direct_protocol_codec::build_direct_response_compat_context(
                &policy.target,
                manifest
                    .features
                    .get("tool_thinking")
                    .copied()
                    .unwrap_or(false),
                manifest
                    .features
                    .get("toolreason_client_projection")
                    .copied()
                    .unwrap_or(true),
                direct_failure_session_scope.session_id(),
                standardized.tool_thinking_turn_context.clone(),
            ) {
                Ok(context) => context,
                Err(error) => {
                    return error_output(
                        runtime_source("V3DirectResp14ProviderCompat", error),
                        trace,
                        &hook_registry,
                    )
                }
            };

        let mut response_projection = match hook_registry
            .run_response_projection_with_context(provider_raw, direct_response_compat_context)
            .await
        {
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
                        continuation_state.as_deref(),
                        continuation_scope.as_ref(),
                        previous_response_id.as_deref(),
                        &selected_pin,
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
                        run_error: crate::hooks::responses_direct_error_hook,
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
                        "responses",
                        "json",
                        Some(event.status),
                        &provider_failure_events,
                        &event,
                        total_attempts(&accumulator, send_attempts),
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        if policy_result.retryable_transient {
                            // 瞬态失败切走：不经过 provider action gate，立即重选。
                            continue;
                        }
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenRetrySame { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        if policy_result.retryable_transient {
                            // 瞬态失败重试同一 provider：不经过 provider action
                            // gate（无 health 记录可等），立即重发。
                            continue;
                        }
                        pending_provider_action_recovery = Some(recovery.clone());
                        continue;
                    }
                    V3Error05ExecutionAction::ProjectTerminal => {
                        if let Err(error) = release_terminal_failure_locator(
                            continuation_state.as_deref(),
                            continuation_scope.as_ref(),
                            previous_response_id.as_deref(),
                            &selected_pin,
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
                            "responses",
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
        trace.push("V3DirectResp14ProviderProjectionPrepared");
        let mut direct_stopless_projected = false;
        // 响应侧密文保留判定（唯一策略）：仅 gpt 模型且当前候选集合只有单一
        // provider 时保留 `encrypted_content` 给 Codex 客户端（客户端用自己的
        // 官方密文重建 reasoning 历史）；其余场景一律在进入客户端前剥离。
        // 与 relay 响应侧共用同一判定与唯一剥离 hook（apply_v3_response_cipher_policy）。
        let retain_response_cipher = expanded
            .as_ref()
            .map(|expanded| {
                crate::hub_v1::is_v3_retain_response_cipher(
                    expanded.candidates.len(),
                    &policy.target.candidate.model_id,
                )
            })
            .unwrap_or(false);
        let direct_web_search_request_state =
            match (stopless_control.as_deref(), stopless_scope.as_ref()) {
                (Some(control), Some(scope)) => match control.web_search_load_for_scope(scope) {
                    Ok(state) => state,
                    Err(error) => {
                        return error_output(
                            runtime_source("V3DirectWebSearchResp01Intercepted", error),
                            trace,
                            &hook_registry,
                        )
                    }
                },
                _ => None,
            };
        if let V3ProviderAttemptBody::Json(body) = &mut response_projection.attempt_payload.body {
            if crate::shared::v3_strip_client_response_id_enabled_for_server(
                manifest,
                &standardized.server_id,
            ) {
                crate::shared::strip_v3_response_id_from_json_body(body);
            }
            // 唯一密文剥离 hook（direct 响应侧）：retain=false 时删除响应中所有
            // Codex 密文（encrypted_content rsn_/gAAAA），客户端只拿到明文 reasoning；
            // relay 响应侧（Resp03）复用同一 hook，保证 direct/relay 策略单一实现。
            routecodex_v3_provider_responses::apply_v3_response_cipher_policy(
                body,
                retain_response_cipher,
            );
            if v3_responses_direct_stopless_center_enabled_for_server(
                manifest,
                &standardized.server_id,
            ) {
                match apply_v3_responses_direct_stopless_json_response_control(
                    V3ResponsesDirectStoplessJsonResponseControlInput {
                        manifest,
                        server_id: &standardized.server_id,
                        stopless_control: stopless_control.as_deref(),
                        stopless_scope: stopless_scope.as_ref(),
                        request_stopless_state: direct_stopless_request_state.as_ref(),
                        request_web_search_state: direct_web_search_request_state.as_ref(),
                        transition_request_id: &standardized.request_id,
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
            } else {
                match apply_v3_responses_direct_web_search_json_response_control(
                    stopless_control.as_deref(),
                    stopless_scope.as_ref(),
                    body,
                    &mut trace,
                ) {
                    Ok(Some(state)) => {
                        // Mode B 本地 websearch 拦截成功。MiniMax hosted
                        // search：结果已随同一响应返回（SearchResultCaptured）
                        // → 跳过搜索 hop；否则执行异步搜索 hop（backend
                        // direct pin 走正常 Hub 链 + VR 路由）。结果投影为
                        // hosted web_search_call + 原 call_id 配对。
                        let captured = if state.phase()
                            == crate::hub_v1::V3WebSearchCenterPhase::SearchResultCaptured
                        {
                            state
                        } else {
                            let backend_binding =
                                crate::hub_v1::resolve_request_web_search_backend_binding(
                                    manifest,
                                    &standardized.body,
                                );
                            match crate::hub_v1::execute_local_web_search_hop(
                                manifest,
                                &standardized.server_id,
                                &direct_failure_session_scope,
                                &provider_health,
                                backend_binding.as_deref(),
                                &state,
                                transport,
                                &standardized.request_id,
                                true,
                            )
                            .await
                            {
                                Ok(captured) => captured,
                                Err(error) => {
                                    return error_output(
                                        runtime_source(
                                            "V3DirectWebSearchResp02RuntimeControlUpdated",
                                            error,
                                        ),
                                        trace,
                                        &hook_registry,
                                    )
                                }
                            }
                        };
                        match crate::hub_v1::project_web_search_result_into_finalized(
                            body, &captured,
                        ) {
                            Ok(()) => {}
                            Err(error) => {
                                return error_output(
                                    runtime_source(
                                        "V3DirectWebSearchResp03HostedResultProjected",
                                        error,
                                    ),
                                    trace,
                                    &hook_registry,
                                )
                            }
                        }
                        if let (Some(control), Some(scope)) =
                            (stopless_control.as_ref(), stopless_scope.as_ref())
                        {
                            if let Err(error) = control.web_search_store_for_scope(
                                scope,
                                captured,
                                V3ServerToolCenterWriteOrigin {
                                    module: "kernel",
                                    symbol: "resp02_direct_web_search_control_updated",
                                    stage: "resp02_runtime_control_updated",
                                },
                                Some("resp02 persist captured web_search state"),
                                None,
                            ) {
                                return error_output(
                                    runtime_source(
                                        "V3DirectWebSearchResp02RuntimeControlUpdated",
                                        error,
                                    ),
                                    trace,
                                    &hook_registry,
                                );
                            }
                        }
                        trace.push("V3DirectWebSearchResp03HostedResultProjected");
                        direct_stopless_projected = true;
                    }
                    Ok(None) => {}
                    Err(source) => return error_output(source, trace, &hook_registry),
                }
            }
        }
        let mut client_sse = None;
        if matches!(
            response_projection.attempt_payload.body,
            V3ProviderAttemptBody::Sse(_)
        ) {
            let stream_observation = response_projection
                .stream_observation
                .clone()
                .unwrap_or_default();
            response_projection.stream_observation = Some(stream_observation.clone());
            let body = std::mem::replace(
                &mut response_projection.attempt_payload.body,
                V3ProviderAttemptBody::Bytes(Vec::new()),
            );
            response_projection.attempt_payload.body = match body {
                V3ProviderAttemptBody::Sse(stream) => {
                    let projected =
                        wrap_direct_sse_provider_event_json_observation_stream_with_compat(
                            stream,
                            stream_observation.clone(),
                            runtime_timing.clone(),
                            crate::shared::v3_strip_client_response_id_enabled_for_server(
                                manifest,
                                &standardized.server_id,
                            ),
                            retain_response_cipher,
                            response_projection.compat_plan.provider_protocol,
                            policy.target.candidate.compatibility_profile.as_deref()
                                == Some("responses:deepseek-console-go"),
                            policy.target.candidate.compatibility_profile.as_deref()
                                == Some("responses:thinking-tags"),
                            hook_registry.direct_sse_typed_hooks(),
                            manifest
                                .features
                                .get("tool_thinking")
                                .copied()
                                .unwrap_or(false),
                            manifest
                                .features
                                .get("toolreason_client_projection")
                                .copied()
                                .unwrap_or(true),
                            Some(direct_failure_session_scope.session_id().to_owned()),
                            Some(standardized.request_id.clone()),
                            Some(policy.target.candidate.model_id.clone()),
                            true,
                        );
                    let client_stream =
                        direct_runtime_helpers_stream::commit_direct_sse_attempt_after_terminal(
                            projected,
                        );
                    let client_stream = if let (
                        false,
                        V3RemoteContinuationObservation::Streaming { state },
                        Some(scope),
                    ) = (
                        continuation_disabled,
                        &response_projection.remote_continuation,
                        continuation_scope.as_ref(),
                    ) {
                        wrap_v3_direct_sse_continuation_lifecycle(
                            client_stream,
                            state.clone(),
                            continuation_state.clone(),
                            Some(scope.clone()),
                            previous_response_id.clone(),
                            selected_pin.clone(),
                            selected_capability_revision.clone(),
                            now_epoch_ms,
                        )
                    } else {
                        client_stream
                    };
                    let failure_scope_for_sse_handoff = direct_failure_session_scope.clone();
                    let provider_id_for_sse_handoff = policy.target.candidate.provider_id.clone();
                    let auth_alias_for_sse_handoff = policy.target.candidate.auth_alias.clone();
                    let model_id_for_sse_handoff = policy.target.candidate.model_id.clone();
                    let client_stream = match transport_for_sse_handoff.clone() {
                        Some(transport) => {
                            let raw = raw_for_sse_handoff.clone();
                            let manifest = manifest_for_sse_handoff.clone();
                            let state = state_for_sse_handoff.clone();
                            let hooks = hook_registry_for_sse_handoff;
                            let failure_scope = failure_scope_for_sse_handoff.clone();
                            let provider_id = provider_id_for_sse_handoff.clone();
                            let auth_alias = auth_alias_for_sse_handoff.clone();
                            let model_id = model_id_for_sse_handoff.clone();
                            direct_runtime_helpers_stream::wrap_direct_sse_provider_handoff_stream(
                                client_stream,
                                response_projection.compat_plan.provider_protocol,
                                move |error| {
                                    let transport = transport.clone();
                                    let raw = raw.clone();
                                    let manifest = manifest.clone();
                                    let mut state = state.clone();
                                    let failure_scope = failure_scope.clone();
                                    let provider_id = provider_id.clone();
                                    let auth_alias = auth_alias.clone();
                                    let model_id = model_id.clone();
                                    async move {
                                        if let Some(health) = state.provider_health.as_ref() {
                                            health
                                                .record_post_commit_provider_stream_failure_from_source(
                                                    &failure_scope,
                                                    &provider_id,
                                                    Some(&auth_alias),
                                                    Some(&model_id),
                                                    &error,
                                                )
                                                .map_err(|message| {
                                                    build_v3_error_01_source_raised(
                                                        V3ErrorSourceKind::RuntimeFailure,
                                                        "V3DirectSseHandoffRuntime",
                                                        "provider_stream_failure_bookkeeping_failed",
                                                        message,
                                                    )
                                                })?;
                                        }
                                        let next = tokio::task::spawn_blocking(move || {
                                            let runtime =
                                                tokio::runtime::Builder::new_current_thread()
                                                    .enable_all()
                                                    .build()
                                                    .map_err(|error| error.to_string())?;
                                            Ok::<_, String>(runtime.block_on(
                                                execute_v3_responses_direct_runtime_kernel_core(
                                                    state,
                                                    &manifest,
                                                    raw,
                                                    hooks,
                                                    transport.as_ref(),
                                                ),
                                            ))
                                        })
                                        .await
                                        .map_err(|error| {
                                            build_v3_error_01_source_raised(
                                                V3ErrorSourceKind::RuntimeFailure,
                                                "V3DirectSseHandoffRuntime",
                                                "provider_stream_handoff_runtime_join_failed",
                                                error.to_string(),
                                            )
                                        })?
                                        .map_err(|message| {
                                            build_v3_error_01_source_raised(
                                                V3ErrorSourceKind::RuntimeFailure,
                                                "V3DirectSseHandoffRuntime",
                                                "provider_stream_handoff_runtime_failed",
                                                message,
                                            )
                                        })?;
                                        match next.client_payload.body {
                                            V3ClientBody::Sse(stream) => Ok(Some(stream)),
                                            V3ClientBody::Json(_)
                                            | V3ClientBody::Bytes(_)
                                            | V3ClientBody::CommittedSse(_) => Ok(None),
                                        }
                                    }
                                },
                                Some(8),
                            )
                        }
                        None => {
                            direct_runtime_helpers_stream::wrap_direct_sse_provider_handoff_stream(
                                client_stream,
                                response_projection.compat_plan.provider_protocol,
                                |error| async move { Err(error) },
                                Some(0),
                            )
                        }
                    };
                    drop(provider_action_permit.take());
                    client_sse = Some(client_stream);
                    V3ProviderAttemptBody::Bytes(Vec::new())
                }
                other => other,
            };
        }
        let attempt_body = std::mem::replace(
            &mut response_projection.attempt_payload.body,
            V3ProviderAttemptBody::Bytes(Vec::new()),
        );
        let committed_client_sse = false;
        let client_body = match (client_sse, attempt_body) {
            (Some(stream), V3ProviderAttemptBody::Bytes(bytes)) if bytes.is_empty() => {
                V3ClientBody::Sse(stream)
            }
            (None, V3ProviderAttemptBody::Json(body)) => V3ClientBody::Json(body),
            (None, V3ProviderAttemptBody::Bytes(body)) => V3ClientBody::Bytes(body),
            _ => {
                return error_output(
                    runtime_source(
                        "V3DirectResp14ProviderCompat",
                        "provider attempt did not resolve to one final client body",
                    ),
                    trace,
                    &hook_registry,
                )
            }
        };
        let client_payload = V3Resp15ClientPayload {
            status: response_projection.attempt_payload.status,
            headers: std::mem::take(&mut response_projection.attempt_payload.headers),
            body: client_body,
        };
        let live_client_sse = matches!(&client_payload.body, V3ClientBody::Sse(_));
        if !live_client_sse && !committed_client_sse {
            if let (false, Some(_state), Some(scope)) = (
                continuation_disabled,
                continuation_state.as_ref(),
                continuation_scope.as_ref(),
            ) {
                if let Err(projected) = commit_or_release_v3_direct_continuation(
                    continuation_state.as_deref(),
                    scope,
                    &response_projection.remote_continuation,
                    previous_response_id.as_deref(),
                    &selected_pin,
                    &selected_capability_revision,
                    now_epoch_ms,
                    &mut trace,
                    &hook_registry,
                ) {
                    return projected;
                }
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
        if let Err(error) = commit_route_policy() {
            return error_output(
                runtime_source("V3Router06RoutePoolResolved", error),
                trace,
                &hook_registry,
            );
        }
        trace.push("V3DirectResp15ClientPayloadReady");
        trace.push("V3Resp15ClientPayload");
        let timing = if committed_client_sse {
            match response_projection.stream_observation.as_ref() {
                Some(observation) => match observation.snapshot() {
                    Ok(snapshot) => snapshot.timing,
                    Err(error) => {
                        return error_output(
                            runtime_source("V3RuntimeTimingObservation", error),
                            trace,
                            &hook_registry,
                        )
                    }
                },
                None => None,
            }
        } else if live_client_sse {
            None
        } else {
            match runtime_timing.finish_runtime() {
                Ok(timing) => Some(timing),
                Err(error) => {
                    return error_output(
                        runtime_source("V3RuntimeTimingTerminal", error),
                        trace,
                        &hook_registry,
                    )
                }
            }
        };
        if committed_client_sse && timing.is_none() {
            return error_output(
                runtime_source(
                    "V3RuntimeTimingTerminal",
                    "successful Direct SSE completed without typed timing",
                ),
                trace,
                &hook_registry,
            );
        }
        let mut observability = build_v3_direct_runtime_observability(
            &policy.target,
            "responses",
            v3_direct_client_transport_label(&client_payload),
            Some(provider_status),
            "completed",
            provider_failure_events.clone(),
            direct_stopless_projected,
        );
        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
        observability.timing = timing;

        return V3ResponsesDirectRuntimeOutput {
            observability: Some(observability),
            stream_observation: response_projection.stream_observation.clone(),
            client_payload,
            node_trace: trace,
            error_chain: None,
            protocol_relay_handoff: None,
        };
    }
}

include!("kernel/direct_stopless.rs");
include!("kernel/direct_runtime_helpers.rs");
include!("kernel/v3_direct_core.rs");
include!("kernel/direct_continuation_commit.rs");
#[cfg(test)]
mod tests;
