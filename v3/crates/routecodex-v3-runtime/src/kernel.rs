use crate::direct_response_hooks::V3DirectResponseCompatBlock;
use crate::hooks::{build_v3_provider_error_source, V3HookRegistry};
use crate::hub_v1::{
    build_provider_resp_compat_02_from_v3_provider_resp_inbound_01,
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02,
    build_v3_provider_resp_inbound_01_raw_with_compat_profile, record_v3_provider_sse_json_frame,
    V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
    V3HubRelayRequestHookEvent, V3HubRelayResponseHookProfile, V3HubTransportIntent,
    V3ProviderRespInbound01RawContext, V3RuntimeObservability, V3RuntimeProviderFailureEventSink,
    V3RuntimeProviderFailureObservation, V3RuntimeRouteSelectionEventSink,
    V3RuntimeStreamObservation,
};
use crate::nodes::*;
use crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key;
use crate::provider_failure_runtime_policy::{
    select_v3_target_with_session_then_global, V3ProviderFailureRuntimeHealth,
};
use crate::runtime_timing::{V3RuntimeObservabilityAccumulator, V3RuntimeTimingState};
use crate::shared::V3ProviderAttemptBody;
use crate::sse_object_pipeline::process_sse_object_frame;
use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime, V3DryRunFixture};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    is_v3_retryable_transient_source, V3Error01SourceRaised, V3Error05ExecutionAction,
    V3Error05ExecutionDecision, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3ExternalHttpWitness, V3ProviderFailureSessionScope,
    V3ProviderTerminalDisposition, V3_ERROR_CHAIN_NODE_IDS, V3_TRANSIENT_TRANSPORT_HANG_CODE,
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
mod direct_client_sse_collapse;
mod direct_execution_control;
mod direct_runtime_timing;
mod direct_sse_consumers;
use direct_execution_control::resolve_v3_direct_request_execution_control;
use direct_runtime_timing::finish_v3_direct_runtime_timing;
pub(crate) use direct_sse_consumers::V3DirectSseTypedHookCatalog;
mod v3_direct_gemini_codec;
mod v3_direct_protocol_codec;
pub use v3_direct_gemini_codec::V3GeminiDirectCodec;
pub use v3_direct_protocol_codec::{V3ChatDirectCodec, V3DirectProtocolCodec};
mod v3_direct_anthropic_codec;
pub use v3_direct_anthropic_codec::{
    V3AnthropicDirect11Policy, V3AnthropicDirectCodec, V3Req04StandardizedAnthropic,
};
#[path = "kernel/default_transport.rs"]
mod default_transport;
pub use default_transport::{
    default_provider_transport_handoff_checkpoints, default_responses_transport,
    restore_default_provider_transport_handoff_checkpoints,
};

/// Bound a provider response-head await by the earlier of the Provider response
/// timeout and the original request residence deadline. The boolean is true when
/// the residence deadline is the binding edge, so the caller can distinguish a
/// request-local deadline expiry from a Provider response timeout.
pub(crate) fn v3_provider_send_deadline(
    provider_timeout: std::time::Duration,
    residence_deadline: std::time::Instant,
) -> (tokio::time::Instant, bool) {
    let provider_deadline = tokio::time::Instant::now() + provider_timeout;
    let residence_deadline = tokio::time::Instant::from_std(residence_deadline);
    if residence_deadline <= provider_deadline {
        (residence_deadline, true)
    } else {
        (provider_deadline, false)
    }
}

/// Remove one pre-registered provider transport attempt from the default broker
/// after Runtime drops the send future at the request deadline. The attempt is
/// started by `begin_transport_attempt` before Runtime enters its outer wait.
/// Custom injected transports that do not own the default broker return no
/// control from `begin_transport_attempt` and are not covered by this cleanup.
pub(crate) fn v3_discard_provider_transport_attempt(
    attempt_control: Option<&routecodex_v3_provider_responses::V3ProviderTransportAttemptControl>,
) {
    let Some(control) = attempt_control else {
        return;
    };
    if let Some(fact) = control.send_fact() {
        default_responses_transport()
            .transport_handoff_broker()
            .remove(&fact.key);
    }
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
    execute_v3_responses_direct_runtime_kernel_core_resident(
        state,
        manifest,
        raw,
        hook_registry,
        transport,
    )
    .await
}
/// A provider failure after the client commit cannot switch candidate or retry,
/// but it is still a provider-health event. Record it for the exact attempted
/// identity so a provider that breaks mid-stream cools down like it does on the
/// Relay post-commit path. Returns a trace node when the bookkeeping itself
/// fails, so the record attempt is never silently dropped.
fn record_post_commit_direct_provider_failure(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    source: &V3Error01SourceRaised,
) -> Result<(), &'static str> {
    if source.source_kind != V3ErrorSourceKind::ProviderFailure {
        return Ok(());
    }
    provider_health
        .record_post_commit_provider_stream_failure_from_source_for_interface(
            failure_session_scope,
            &selected.candidate.provider_id,
            &selected.candidate.interface_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            source,
        )
        .map_err(|_| "V3DirectPostCommitProviderHealthRecord")
}

async fn execute_v3_responses_direct_runtime_kernel_core_resident<
    T: ResponsesTransport + ?Sized,
>(
    state: V3ResponsesDirectRuntimeCoreState,
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
        now_epoch_ms,
        provider_health,
        initial_selected_target,
        initial_expanded,
        initial_request_local_excluded_candidates,
        initial_route_policy_scope,
        initial_route_policy_pending,
        initial_protocol_decision,
        initial_plan_trace,
        provider_health_neutral,
        provider_failure_event_sink,
        route_selection_event_sink,
        client_frame_sink,
        observability_accumulator: _,
        request_execution_control,
    } = state;

    // stage-3 丢弃记录要写「客户端原始值」，必须在 Req04 归一化之前取句柄：
    // `standardized.body` 之后会被 control prepare 与 before-send 改写。
    let client_original_body = std::sync::Arc::new(raw.body.clone());
    let mut standardized = match build_v3_req_04_standardized_responses_from_v3_server_03(raw) {
        Ok(standardized) => standardized,
        Err(error) => {
            trace.push("V3Req04StandardizedResponses");
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source("V3Req04StandardizedResponses", error),
                None,
                trace,
                &hook_registry,
            );
        }
    };
    trace.push("V3Req04StandardizedResponses");
    let request_execution_control = match resolve_v3_direct_request_execution_control(
        request_execution_control,
        manifest,
        &standardized.server_id,
    ) {
        Ok(control) => control,
        Err(source) => {
            return direct_runtime_helpers_stream::source_failure_output(
                source,
                None,
                trace,
                &hook_registry,
            )
        }
    };
    let attempt_budget = request_execution_control.attempt_budget();
    if let Some(plan_trace) = initial_plan_trace {
        // Reuse the Server's Router05..Target09 trace without re-entering the Router.
        trace.extend(plan_trace);
    }
    if let Some(source) = v3_direct_retired_continuation_error(&standardized.body) {
        return direct_runtime_helpers_stream::source_failure_output(
            source,
            None,
            trace,
            &hook_registry,
        );
    }
    if let Err(message) = validate_initial_direct_plan(
        initial_selected_target.is_some(),
        initial_protocol_decision.is_some(),
    ) {
        trace.push("V3Execution11ProtocolDecision");
        return direct_runtime_helpers_stream::source_failure_output(
            runtime_source("V3Execution11ProtocolDecision", message),
            None,
            trace,
            &hook_registry,
        );
    }
    let direct_failure_session_scope = standardized.failure_session_scope.clone();
    let provider_health =
        provider_health.unwrap_or_else(|| V3ProviderFailureRuntimeHealth::from_manifest(manifest));
    let availability = provider_health.session_bound_availability(&direct_failure_session_scope);
    let mut pinned_selected = None;
    let initial_selected_target_present = initial_selected_target.is_some();
    let mut route_policy_pending = initial_route_policy_pending;
    let mut route_policy_scope = initial_route_policy_scope.unwrap_or_else(|| {
        crate::route_policy::V3RoutePolicyScope::without_conversation(
            &standardized.server_id,
            direct_failure_session_scope.routing_group(),
            direct_failure_session_scope.session_id(),
            &standardized.server_id,
        )
        .with_conversation(direct_failure_session_scope.session_id())
    });
    let (mut expanded, mut target_source) = if let Some(initial_expanded) = initial_expanded {
        // Server-side protocol plan already ran Router05..Target09; reuse its
        // candidate set for in-Target reselection instead of re-entering the
        // Router.
        (
            Some(initial_expanded.clone()),
            Some(
                crate::operation_runner::plan_execution::V3PlanExecutionTargetSource::Expanded(
                    initial_expanded,
                ),
            ),
        )
    } else if pinned_selected.is_none() && !initial_selected_target_present {
        let request_is_compaction = standardized.request_purpose.is_compaction()
            || standardized
                .endpoint
                .trim_end_matches('/')
                .ends_with("/responses/compact");
        let resolved = crate::operation_runner::run_v3_resolve_target_operator(
            standardized.body.clone(),
            crate::operation_runner::V3ResolveTargetExecutionMode::DirectFresh {
                manifest: std::sync::Arc::new(manifest.clone()),
                server_id: standardized.server_id.clone(),
                endpoint_path: standardized.endpoint.clone(),
                entry_protocol: "responses".to_string(),
                request_id: standardized.request_id.clone(),
                session_id: direct_failure_session_scope.session_id().to_string(),
                conversation_id: direct_failure_session_scope.session_id().to_string(),
                port: standardized.server_id.clone(),
                longcontext_threshold_tokens: crate::configured_v3_longcontext_threshold_tokens(
                    manifest,
                    &standardized.server_id,
                ),
                is_compaction: request_is_compaction,
                now_epoch_ms,
            },
        );
        let (resolved_request, resolved_target) = match resolved {
            Ok(value) => value,
            Err(crate::operation_runner::V3ResolveTargetOperatorError::Typed(source)) => {
                return error_output(source, trace, &hook_registry);
            }
            Err(crate::operation_runner::V3ResolveTargetOperatorError::OperatorFault(fault)) => {
                return direct_runtime_helpers_stream::operator_fault_output(
                    fault,
                    trace,
                    &hook_registry,
                );
            }
            Err(crate::operation_runner::V3ResolveTargetOperatorError::Runner(error)) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3Router07OpaqueTargetHitOnce", error),
                    None,
                    trace,
                    &hook_registry,
                );
            }
        };
        standardized.body = resolved_request;
        route_policy_pending = resolved_target.route_policy_pending;
        if let Some(scope) = resolved_target.route_policy_scope {
            route_policy_scope = scope;
        }
        trace.extend([
            "V3Router05RequestClassified",
            "V3Router06RoutePoolResolved",
            "V3Router07OpaqueTargetHitOnce",
        ]);
        (
            None,
            Some(
                crate::operation_runner::plan_execution::V3PlanExecutionTargetSource::OpaqueHit(
                    resolved_target.opaque_hit,
                ),
            ),
        )
    } else {
        (None, None)
    };
    let standardized_request_id = standardized.request_id.clone();
    let standardized_server_id = standardized.server_id.clone();
    let commit_route_policy = |_receipt: &V3AttemptSuccessReceipt| -> Result<(), String> {
        match route_policy_pending.as_ref() {
            Some(pending) => pending.commit::<String>(),
            None => Ok(()),
        }
    };
    let mut failed_candidates = initial_request_local_excluded_candidates;
    // 2026-11-07 ruling ①: complete identities refused at capacity admission.
    // They were never contacted, they are not provider failures, and they stay
    // eligible for the single/last-candidate exemption.
    let mut capacity_skipped: BTreeSet<String> = BTreeSet::new();
    // Set once, after every real candidate failed and only a capacity-skipped
    // identity remains: the next send goes out over the adaptive budget with the
    // transport bypass flag.
    let mut capacity_bypass_granted = false;
    // At most one bounded cooldown-rescue round per request. Provider probing
    // has its own lifecycle; a request never waits for a probe cadence.
    let mut cooldown_rescue_attempted = false;
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut initial_selected_target = initial_selected_target;
    let mut provider_failure_events = Vec::<V3RuntimeProviderFailureObservation>::new();
    let mut last_external_http = None::<V3ExternalHttpWitness>;
    let mut send_attempts = 0usize;
    let mut provider_request_snapshot = None;
    let allowed_modes = direct_runtime_allowed_execution_modes(manifest, &standardized.server_id);
    loop {
        let (selected, planned_decision): (
            routecodex_v3_target::V3Target10ConcreteProviderSelected,
            Option<V3Execution11ProtocolDecision>,
        ) = {
            let pinned = pinned_selected.take();
            let preferred = pinned
                .as_ref()
                .cloned()
                .or_else(|| initial_selected_target.take())
                .or_else(|| retry_selected.take());
            if let Some(source) = target_source.as_ref() {
                let expands_target = matches!(
                    source,
                    crate::operation_runner::plan_execution::V3PlanExecutionTargetSource::OpaqueHit(
                        _
                    )
                );
                match crate::operation_runner::plan_execution::await_v3_plan_execution_with_deadline(
                    attempt_budget.residence_deadline(),
                    crate::operation_runner::plan_execution::run_v3_plan_execution(
                    standardized.body.clone(),
                    manifest,
                    source.clone(),
                    &direct_failure_session_scope,
                    &provider_health,
                    &failed_candidates,
                    now_epoch_ms,
                    0,
                    preferred,
                    crate::operation_runner::plan_execution::V3PlanExecutionModePolicy::DirectEntry {
                        entry_protocol: V3HubEntryProtocol::Responses,
                        allowed_modes: allowed_modes.clone(),
                    },
                ))
                .await
                {
                    Ok((planned_request, plan)) => {
                        standardized.body = planned_request;
                        failed_candidates = plan.request_local_excluded_candidates;
                        expanded = Some(plan.expanded.clone());
                        target_source = Some(crate::operation_runner::plan_execution::V3PlanExecutionTargetSource::Expanded(plan.expanded));
                        if expands_target { trace.extend(["V3Target08KindClassified", "V3Target09CandidateSetExpanded"]); }
                        (plan.selected, Some(plan.protocol_decision))
                    }
                    Err(crate::operation_runner::plan_execution::V3PlanExecutionStop::Failed(source)) => {
                        return error_output(source, trace, &hook_registry);
                    }
                    Err(crate::operation_runner::plan_execution::V3PlanExecutionStop::OperatorFault(fault)) => {
                        return direct_runtime_helpers_stream::operator_fault_output(
                            fault,
                            trace,
                            &hook_registry,
                        );
                    }
                    Err(crate::operation_runner::plan_execution::V3PlanExecutionStop::Exhausted { expanded: exhausted_expanded, exhaustion: error, source, .. }) => {
                        // 2026-11-07 ruling ①: exhaustion is not terminal while a
                        // capacity-skipped identity can still be tried, provided a
                        // real provider failure is what emptied the pool. A pool
                        // that is only *busy* has no provider answer to pass
                        // through and keeps its truthful exhaustion. The skipped
                        // identity was never sent, so it is restored once and
                        // reselected: the plan then holds that single remaining
                        // candidate and the send is stamped with the capacity
                        // bypass instead of being refused at admission again.
                        let real_failure_recorded = failed_candidates
                            .iter()
                            .any(|key| !capacity_skipped.contains(key));
                        if !capacity_bypass_granted
                            && !capacity_skipped.is_empty()
                            && real_failure_recorded
                        {
                            for key in capacity_skipped.iter() {
                                failed_candidates.remove(key);
                            }
                            capacity_bypass_granted = true;
                            trace.push("V3CapacityAdmissionBypassGranted");
                            continue;
                        }
                        // v31: provider lifecycle never gates a request. The
                        // rescue probe is scheduled as a detached control-plane
                        // observation, so this request keeps its truthful typed
                        // exhaustion immediately and a later selection may use
                        // the identity once its own probe has recovered it.
                            provider_health.spawn_v3_background_cooldown_rescue_round(
                                manifest,
                                &exhausted_expanded,
                            );
                        // 2026-11-07 ruling ① diagnostic convention: capacity refusals never run
                        // the failure policy, so the request-local terminal action is stamped on
                        // the last capacity-skipped attempt instead of a policy event.
                        if !real_failure_recorded {
                            if let Some(last) = provider_failure_events.last_mut() {
                                if last.action == "CapacitySkipped" {
                                    last.action = "terminal_request_local_provider_compat_exhausted".to_string();
                                }
                            }
                        }
                        let detail = if error.attempted_candidates.is_empty() {
                            "no candidates".to_string()
                        } else {
                            error.attempted_candidates.join(", ")
                        };
                        let exhausted_observability = V3RuntimeObservability {
                            entry_protocol: "responses".to_string(),
                            routing_group_id: Some(error.route.routing_group_id.clone()),
                            pool_id: Some(error.route.pool_id.clone()),
                            attempts: Some(total_attempts(&accumulator, send_attempts)),
                            provider_failure_events: provider_failure_events.clone(),
                            timing: match runtime_timing.finish_runtime() {
                                Ok(timing) => Some(timing),
                                Err(error) => return direct_runtime_helpers_stream::source_failure_output(
                                    runtime_source("V3RuntimeTimingTerminal", error),
                                    last_external_http,
                                    trace,
                                    &hook_registry,
                                ),
                            },
                            response_status: Some("error".to_string()),
                            unavailable_candidates: error.attempted_candidates.clone(),
                            ..V3RuntimeObservability::default()
                        };
                        return direct_runtime_helpers_stream::target_exhausted_output_with_observability(
                            source.map_or_else(
                                || {
                                    crate::shared::direct_plain_error(
                                        V3ErrorSourceKind::TargetPoolExhausted,
                                        "V3Target10ConcreteProviderSelected",
                                        "selected_target_exhausted",
                                        format!(
                                            "{} candidates unavailable: {detail}",
                                            error.attempted_candidates.len()
                                        ),
                                    )
                                },
                                Ok,
                            ),
                            last_external_http,
                            trace,
                            &hook_registry,
                            Some(exhausted_observability),
                        );
                    }
                }
            } else if let Some(selected) = preferred {
                (selected, None)
            } else {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source(
                        "V3Target09CandidateSetExpanded",
                        "routed candidate set missing",
                    ),
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                );
            }
        };
        trace.push("V3Target10ConcreteProviderSelected");
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
            );
            observability.attempts = Some(total_attempts(&accumulator, send_attempts));
            sink(&observability);
        }
        let decision = match planned_decision.map(Ok).unwrap_or_else(|| {
            build_v3_execution_11_protocol_decision_from_v3_target_10(
                selected.clone(),
                "responses",
                &allowed_modes,
            )
            .map_err(crate::nodes::raise_v3_execution_11_protocol_decision_failure)
        }) {
            Ok(decision) => decision,
            Err(source) => {
                trace.push("V3Execution11ProtocolDecision");
                return direct_runtime_helpers_stream::source_failure_output(
                    source,
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                );
            }
        };
        trace.push("V3Execution11ProtocolDecision");
        if !matches!(
            decision.mode,
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        ) {
            let captured_target_09 = match expanded.as_ref() {
                Some(expanded) => expanded.clone(),
                None => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source(
                            "V3Target09CandidateSetExpanded",
                            "typed Relay handoff requires the captured Target09 candidate set",
                        ),
                        last_external_http.clone(),
                        trace,
                        &hook_registry,
                    )
                }
            };
            return relay_handoff_output(
                decision.target,
                captured_target_09,
                failed_candidates.clone(),
                route_policy_pending.clone(),
                Some(route_policy_scope.clone()),
                trace,
                provider_failure_events.clone(),
                accumulator.with_additional_attempts(send_attempts),
                request_execution_control,
            );
        }
        // Responses direct has a protocol-specific kernel, so it must enter the
        // same Req04 tool-thinking hook explicitly as the generic direct kernel.
        // Keep the injection owner in the shared Responses Direct hook; this call
        // only wires the direct lifecycle edge before policy and provider wire
        // projection.
        if let Err(source) = crate::hooks::responses_direct_prepare_before_send(
            manifest,
            &standardized_server_id,
            &mut standardized,
        ) {
            return direct_runtime_helpers_stream::source_failure_output(
                source,
                last_external_http.clone(),
                trace,
                &hook_registry,
            );
        }

        let transport_identity = v3_relay_provider_candidate_key(&selected.candidate);
        let policy = hook_registry.run_route(selected, &standardized);
        trace.push("V3ResponsesDirect11Policy");

        // stage-3 丢弃上下文：请求身份 + 入口端口 + 客户端原始 payload 句柄 +
        // 独立丢弃日志路径。
        let projection_drop_context = crate::projection_drop_log::V3ProjectionDropContext::new(
            standardized_request_id.clone(),
            standardized
                .port
                .map(|port| port.to_string())
                .unwrap_or_default(),
            manifest.debug.projection_drop_log_file.clone(),
            client_original_body.clone(),
        );
        let wire = match hook_registry
            .run_request_projection_with_drop_context(&policy, &projection_drop_context)
        {
            Ok(value) => value,
            Err(source) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    source,
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                );
            }
        };
        trace.push("V3Provider12ResponsesWirePayload");
        let custom_tool_function_binding = wire.custom_tool_function_binding().cloned();
        let ns_tool_identities = wire.namespace_identities().clone();
        let transport_request = match hook_registry.run_provider_transport(wire) {
            Ok(value) => value,
            Err(source) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    source,
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                );
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
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source(
                        "V3Transport13ResponsesHttpRequest",
                        "provider transport handoff scope is missing",
                    ),
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                )
            }
        };
        let transport_request = match transport_request.with_handoff_scope(handoff_scope) {
            Ok(request) => request,
            Err(error) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3Transport13ResponsesHttpRequest", error),
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                )
            }
        };
        // 2026-11-07 ruling ①: the last eligible candidate is exempt from
        // capacity admission. After the capacity-skipped identity was restored,
        // the plan holds exactly one candidate; this send is stamped so the
        // transport admits it over the adaptive budget and the provider's real
        // answer (or original typed error) passes through to the client.
        let transport_request = if capacity_bypass_granted && policy.target.candidate_count == 1 {
            transport_request.with_capacity_admission_bypass()
        } else {
            transport_request
        };
        trace.push("V3Transport13ResponsesHttpRequest");
        provider_request_snapshot = Some(transport_request.provider_request_projection());

        send_attempts =
            match attempt_budget.admit_transport_attempt_for_identity(Some(&transport_identity)) {
                Ok(attempts) => attempts,
                Err(error) => {
                    return direct_runtime_helpers_stream::source_failure_output(
                        direct_runtime_helpers_stream::direct_attempt_budget_error_source(error),
                        last_external_http.clone(),
                        trace,
                        &hook_registry,
                    )
                }
            };
        if let Err(error) = runtime_timing.start_external() {
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source("V3RuntimeTimingExternal", error),
                last_external_http.clone(),
                trace,
                &hook_registry,
            );
        }
        // The current-attempt witness starts empty for every real send. A prior
        // attempt's HTTP response is never evidence for this attempt, so a
        // pre-head transport failure here must not inherit it.
        last_external_http = None;
        // The send await must not outlive the original request residence deadline.
        // The earlier of the Provider timeout and the residence deadline is the
        // binding edge, and only the residence deadline is request-local.
        let send_attempt_control = transport.begin_transport_attempt(&transport_request);
        let (send_deadline, residence_is_binding) = v3_provider_send_deadline(
            default_transport::responses_direct_transport_response_timeout(
                manifest,
                &policy.target.candidate.provider_id,
            ),
            attempt_budget.residence_deadline(),
        );
        let mut request_deadline_expired = false;
        let provider_raw = match {
            match send_attempt_control {
                Ok(attempt_control) => {
                    let cleanup_control = attempt_control.clone();
                    match tokio::time::timeout_at(
                        send_deadline,
                        transport.send_observed(transport_request, attempt_control),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(_elapsed) => {
                            if residence_is_binding {
                                v3_discard_provider_transport_attempt(cleanup_control.as_ref());
                                request_deadline_expired = true;
                                Err(V3ProviderError::Transport {
                                    request_id: standardized.request_id.clone(),
                                    provider_id: policy.target.candidate.provider_id.clone(),
                                    reason:
                                        "request residence deadline expired awaiting provider response head"
                                            .to_string(),
                                })
                            } else {
                                // provider 挂起（响应头等待超时）：归一化为 transport 错误进入错误链
                                // （reselect 切 provider + health 记录），错误只反映 provider 行为。
                                Err(V3ProviderError::Transport {
                                    request_id: standardized.request_id.clone(),
                                    provider_id: policy.target.candidate.provider_id.clone(),
                                    reason: default_transport::V3_DIRECT_TRANSPORT_HANG_REASON
                                        .to_string(),
                                })
                            }
                        }
                    }
                }
                Err(error) => Err(error),
            }
        } {
            Ok(raw) => raw,
            Err(error) => {
                if request_deadline_expired {
                    return direct_runtime_helpers_stream::source_failure_output(
                        direct_runtime_helpers_stream::direct_attempt_store_error_source(
                            crate::nodes::V3AttemptStoreError::ResidenceDeadlineExceeded(
                                "request residence deadline expired while awaiting the provider response head".to_string(),
                            ),
                            "V3ExecutionAttemptBudget",
                            "request_residence_deadline_expired",
                        ),
                        last_external_http,
                        trace,
                        &hook_registry,
                    );
                }
                // 2026-11-07 ruling ①: capacity admission is local provider
                // capacity, not a provider failure. The identity was never
                // contacted, so it is recorded as capacity-skipped and the
                // request continues with the next visible candidate instead of
                // cooling a healthy provider or turning the refusal into a
                // terminal.
                if !capacity_bypass_granted
                    && matches!(&error, V3ProviderError::ConcurrencyBusy { .. })
                {
                    let busy_key = v3_relay_provider_candidate_key(&policy.target.candidate);
                    capacity_skipped.insert(busy_key.clone());
                    failed_candidates.insert(busy_key);
                    trace.push("V3ProviderCapacitySkipped");
                    provider_failure_events.push(
                        crate::hub_v1::build_v3_runtime_capacity_skipped_failure_observation(
                            &policy.target.candidate,
                        ),
                    );
                    // The send opened this attempt's external timing; a capacity
                    // refusal still has to close it, or the next attempt cannot
                    // start its own.
                    if let Err(timing_error) = runtime_timing.finish_external() {
                        return direct_runtime_helpers_stream::source_failure_output(
                            runtime_source("V3RuntimeTimingExternal", timing_error),
                            last_external_http.clone(),
                            trace,
                            &hook_registry,
                        );
                    }
                    // A capacity refusal never contacted the identity, so the
                    // cooled peer is the only identity that can still answer,
                    // and the next selection promotes it immediately. The peer's
                    // own probe is scheduled as a detached control-plane
                    // observation: it refreshes the identity's visibility for
                    // later selections without holding this request.
                    if !cooldown_rescue_attempted {
                        cooldown_rescue_attempted = true;
                            if let Some(captured) = expanded.as_ref() {
                                provider_health.spawn_v3_background_cooldown_rescue_round(
                                    manifest,
                                    captured,
                                );
                            }
                    }
                    continue;
                }
                let failed_attempt_evidence =
                    crate::hub_v1::build_v3_runtime_provider_failed_attempt_evidence_from_error(
                        total_attempts(&accumulator, send_attempts),
                        provider_request_snapshot.clone(),
                        &error,
                    );
                if let Some(witness) =
                    crate::hub_v1::external_http_witness_from_provider_error(&error)
                {
                    last_external_http = Some(witness);
                }
                if let Err(timing_error) = runtime_timing.finish_external() {
                    return direct_runtime_helpers_stream::source_failure_output(
                        runtime_source("V3RuntimeTimingExternal", timing_error),
                        last_external_http.clone(),
                        trace,
                        &hook_registry,
                    );
                }
                let hang = matches!(
                    &error,
                    V3ProviderError::Transport { reason, .. }
                        if reason == default_transport::V3_DIRECT_TRANSPORT_HANG_REASON
                            || routecodex_v3_error::is_v3_provider_response_header_timeout_reason(
                                reason,
                            )
                );
                let source = match build_v3_provider_error_source(
                    "V3Transport13ResponsesHttpRequest",
                    error,
                ) {
                    Ok(source) => source,
                    Err(fault) => {
                        let mut observability = build_v3_direct_runtime_observability(
                            &policy.target,
                            "responses",
                            if standardized
                                .body
                                .get("stream")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false)
                            {
                                "sse"
                            } else {
                                "json"
                            },
                            None,
                            "failed",
                            provider_failure_events.clone(),
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                                Err(fault),
                                last_external_http,
                                trace,
                                &hook_registry,
                                Some(observability),
                                provider_request_snapshot,
                                None,
                            );
                    }
                };
                if source.source_kind != V3ErrorSourceKind::ProviderFailure
                    && !routecodex_v3_error::is_v3_recoverable_response_processing_source(&source)
                {
                    return error_output(source, trace, &hook_registry);
                }
                // 挂起由错误处理中心按「transport 阶段 + 专属 code」判定为瞬态
                // （health-neutral 重试 3 次），不在构造处打标记。
                let source = if hang {
                    let mut source = source;
                    source.code = V3_TRANSIENT_TRANSPORT_HANG_CODE.to_string();
                    source
                } else {
                    source
                };
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        failure_session_scope: &direct_failure_session_scope,
                        provider_health: &provider_health,
                        availability: &availability,
                        expanded: expanded.as_ref(),
                        provider_pinned: false,
                        now_epoch_ms,
                        manifest: &manifest,
                    },
                    &policy.target,
                    source,
                    502,
                    &mut V3DirectProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        capacity_skipped: &capacity_skipped,
                        trace: &mut trace,
                    },
                    last_external_http.as_ref(),
                )
                .await
                {
                    Ok(result) => result,
                    Err(failure) => {
                        return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                            failure,
                            last_external_http,
                            trace,
                            None,
                        )
                    }
                };
                if let Some(mut event) = policy_result.event.clone() {
                    event.failed_attempt_evidence = failed_attempt_evidence;
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink.as_ref(),
                        &policy.target,
                        "responses",
                        "json",
                        event.external_error_status,
                        &provider_failure_events,
                        &event,
                        total_attempts(&accumulator, send_attempts),
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::ReevaluateTarget => {
                        retry_selected = None;
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        if policy_result.retryable_transient {
                            // 瞬态失败切走：不经过 provider action gate，立即重选。
                            continue;
                        }
                        continue;
                    }
                    V3Error05ExecutionAction::ProjectTerminal => {
                        let mut observability = build_v3_direct_runtime_observability(
                            &policy.target,
                            "responses",
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        return direct_runtime_helpers_stream::provider_terminal_output(
                            policy_result.decision,
                            policy_result.terminal_disposition,
                            last_external_http,
                            trace,
                            Some(observability),
                            provider_request_snapshot,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::ClientDisconnected => {
                        return direct_runtime_helpers_stream::client_disconnect_terminal_output(
                            policy_result.decision,
                            trace,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::RejectNonProviderError => {
                        return direct_runtime_helpers_stream::source_failure_output(
                            runtime_source(
                                "V3Error05ExecutionDecision",
                                "provider failure entered a non-provider Error05 lane",
                            ),
                            last_external_http.clone(),
                            trace,
                            &hook_registry,
                        )
                    }
                }
            }
        };
        let provider_response_is_stream =
            provider_raw.body_kind() == V3ProviderResponseBodyKind::Sse;
        // The upstream answered: from this instant its head is real evidence,
        // whatever the body turns out to be. Recorded before the body is
        // interpreted so a stream whose payload never decodes is never reported
        // as if no response had arrived. A branch below that can read a body
        // replaces this with the fuller witness.
        last_external_http = Some(crate::hub_v1::external_http_witness_head(&provider_raw));
        if !provider_response_is_stream {
            if let Err(error) = runtime_timing.finish_external() {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3RuntimeTimingExternal", error),
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                );
            }
        }
        let provider_status = provider_raw.status();
        trace.push("V3ProviderResp14Raw");
        let mut provider_response_snapshot = None;
        if let Some(body) = provider_raw.json_body() {
            provider_response_snapshot = Some(json!({
                "status": provider_raw.status(),
                "providerId": provider_raw.provider_id(),
                "bodyKind": "json",
                "body": serde_json::from_slice::<serde_json::Value>(body)
                    .unwrap_or_else(|_| json!({"rawBody": String::from_utf8_lossy(body)})),
            }));
            // The real upstream response is retained even when it is not
            // eligible for client projection (bug `705d624` keeps HTTP 502 out
            // of any client response). Evidence capture is decoupled from that
            // rule, so the status and body are never dropped.
            last_external_http = Some(V3ExternalHttpWitness::new(
                provider_status,
                provider_raw
                    .headers()
                    .iter()
                    .map(|header| (header.name.clone(), header.value.clone()))
                    .collect(),
                body.to_vec(),
            ));
        }

        let direct_dsml_context = crate::direct_response_hooks::V3DirectDsmlContext::from_request(
            &standardized.body,
            &ns_tool_identities,
        );
        let compat_context = match v3_direct_protocol_codec::build_direct_response_compat_context(
            &policy.target,
            ns_tool_identities.clone(),
            crate::hub_v1::v3_tool_thinking_enabled_for_server(manifest, &standardized.server_id),
            crate::hub_v1::v3_toolreason_client_projection_enabled_for_server(
                manifest,
                &standardized.server_id,
            ),
            direct_failure_session_scope.session_id(),
            standardized.tool_thinking_turn_context.clone(),
            custom_tool_function_binding,
        ) {
            Ok(context) => context,
            Err(error) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    runtime_source("V3DirectResp14ProviderCompat", error),
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                )
            }
        };

        let mut response_projection = match hook_registry
            .run_response_projection_with_context(provider_raw, compat_context)
            .await
        {
            Ok(projection) => projection,
            Err(Err(fault)) => {
                return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                    Err(fault),
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                    None,
                    provider_request_snapshot,
                    None,
                )
            }
            Err(Ok(source)) => {
                let transport_source = source.clone();
                if provider_response_is_stream {
                    if let Err(error) = runtime_timing.finish_external() {
                        return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                            runtime_source("V3RuntimeTimingExternal", error),
                            last_external_http.clone(),
                            trace,
                            &hook_registry,
                            None,
                            provider_request_snapshot,
                            None,
                        );
                    }
                }
                if !matches!(source.source_kind, V3ErrorSourceKind::ProviderFailure)
                    && !routecodex_v3_error::is_v3_recoverable_response_processing_source(&source)
                {
                    return direct_runtime_helpers_stream::source_failure_output_with_observability_and_snapshots(
                        Ok(source),
                        last_external_http.clone(),
                        trace,
                        &hook_registry,
                        None,
                        provider_request_snapshot,
                        None,
                    );
                }
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        failure_session_scope: &direct_failure_session_scope,
                        provider_health: &provider_health,
                        availability: &availability,
                        expanded: expanded.as_ref(),
                        provider_pinned: false,
                        now_epoch_ms,
                        manifest: &manifest,
                    },
                    &policy.target,
                    source,
                    provider_status,
                    &mut V3DirectProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        capacity_skipped: &capacity_skipped,
                        trace: &mut trace,
                    },
                    last_external_http.as_ref(),
                )
                .await
                {
                    Ok(result) => result,
                    Err(failure) => {
                        return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                            failure,
                            last_external_http,
                            trace,
                            None,
                        )
                    }
                };
                if let Some(event) = policy_result.event.clone() {
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink.as_ref(),
                        &policy.target,
                        "responses",
                        if provider_response_is_stream {
                            "sse"
                        } else {
                            "json"
                        },
                        event.external_error_status,
                        &provider_failure_events,
                        &event,
                        total_attempts(&accumulator, send_attempts),
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::ReevaluateTarget => {
                        retry_selected = None;
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        if policy_result.retryable_transient {
                            // 瞬态失败切走：不经过 provider action gate，立即重选。
                            continue;
                        }
                        continue;
                    }
                    V3Error05ExecutionAction::ProjectTerminal => {
                        let mut observability = build_v3_direct_runtime_observability(
                            &policy.target,
                            "responses",
                            if provider_response_is_stream {
                                "sse"
                            } else {
                                "json"
                            },
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        return direct_runtime_helpers_stream::provider_terminal_output(
                            policy_result.decision,
                            policy_result.terminal_disposition,
                            last_external_http,
                            trace,
                            Some(observability),
                            provider_request_snapshot,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::ClientDisconnected => {
                        return direct_runtime_helpers_stream::client_disconnect_terminal_output(
                            policy_result.decision,
                            trace,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::RejectNonProviderError => {
                        return direct_runtime_helpers_stream::source_failure_output(
                            runtime_source(
                                "V3Error05ExecutionDecision",
                                "provider failure entered a non-provider Error05 lane",
                            ),
                            last_external_http.clone(),
                            trace,
                            &hook_registry,
                        )
                    }
                }
            }
        };
        trace.push("V3DirectResp14ProviderProjectionPrepared");
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
        if let V3ProviderAttemptBody::Json(body) = &mut response_projection.attempt_payload.body {
            let normalization = hook_registry
                .project_complete_direct_json(body, &direct_dsml_context)
                .map_err(crate::hooks::direct_complete_response_error_source);
            if normalization.is_ok() {
                crate::direct_response_hooks::apply_v3_direct_response_projection_hooks(
                    body,
                    crate::shared::v3_strip_client_response_id_enabled_for_server(
                        manifest,
                        &standardized.server_id,
                    ),
                    retain_response_cipher,
                    response_projection.compat_plan.provider_protocol,
                );
            }
            if let Err(source) = normalization.and_then(|()| {
                crate::shared::enforce_v3_provider_json_attempt_admission(
                    response_projection.compat_plan.provider_protocol,
                    body,
                    &policy.target.candidate.provider_id,
                    provider_status,
                )
            }) {
                let source = match source {
                    Ok(source) => source,
                    Err(fault) => {
                        return direct_runtime_helpers_stream::source_failure_output(
                            Err(fault),
                            last_external_http.clone(),
                            trace,
                            &hook_registry,
                        )
                    }
                };
                let policy_result = match run_v3_direct_provider_failure_policy(
                    &V3DirectProviderFailurePolicyContext {
                        failure_session_scope: &direct_failure_session_scope,
                        provider_health: &provider_health,
                        availability: &availability,
                        expanded: expanded.as_ref(),
                        provider_pinned: false,
                        now_epoch_ms,
                        manifest: &manifest,
                    },
                    &policy.target,
                    source,
                    provider_status,
                    &mut V3DirectProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        capacity_skipped: &capacity_skipped,
                        trace: &mut trace,
                    },
                    last_external_http.as_ref(),
                )
                .await
                {
                    Ok(result) => result,
                    Err(failure) => {
                        return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                            failure,
                            last_external_http,
                            trace,
                            None,
                        )
                    }
                };
                if let Some(event) = policy_result.event.clone() {
                    provider_failure_events.push(event.clone());
                    publish_v3_direct_provider_failure_event(
                        provider_failure_event_sink.as_ref(),
                        &policy.target,
                        "responses",
                        "json",
                        event.external_error_status,
                        &provider_failure_events,
                        &event,
                        total_attempts(&accumulator, send_attempts),
                    );
                }
                match &policy_result.decision.action {
                    V3Error05ExecutionAction::ReevaluateTarget => {
                        retry_selected = None;
                        continue;
                    }
                    V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                        retry_selected = policy_result.retry_selected.map(|selected| *selected);
                        continue;
                    }
                    V3Error05ExecutionAction::ProjectTerminal => {
                        let mut observability = build_v3_direct_runtime_observability(
                            &policy.target,
                            "responses",
                            "json",
                            policy_result.event.as_ref().map(|event| event.status),
                            "failed",
                            provider_failure_events.clone(),
                        );
                        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
                        return direct_runtime_helpers_stream::provider_terminal_output(
                            policy_result.decision,
                            policy_result.terminal_disposition,
                            last_external_http,
                            trace,
                            Some(observability),
                            provider_request_snapshot,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::ClientDisconnected => {
                        return direct_runtime_helpers_stream::client_disconnect_terminal_output(
                            policy_result.decision,
                            trace,
                            None,
                        );
                    }
                    V3Error05ExecutionAction::RejectNonProviderError => {
                        return direct_runtime_helpers_stream::source_failure_output(
                            runtime_source(
                                "V3Error05ExecutionDecision",
                                "post-hook admission entered a non-provider Error05 lane",
                            ),
                            last_external_http.clone(),
                            trace,
                            &hook_registry,
                        )
                    }
                }
            }
        }
        let attempt_body = std::mem::replace(
            &mut response_projection.attempt_payload.body,
            V3ProviderAttemptBody::Bytes(Vec::new()),
        );
        let committed_client_sse = matches!(&attempt_body, V3ProviderAttemptBody::Sse(_));
        let (client_body, attempt_success_receipt) = match attempt_body {
            V3ProviderAttemptBody::Sse(stream) => {
                let stream_observation = response_projection
                    .stream_observation
                    .clone()
                    .unwrap_or_default();
                response_projection.stream_observation = Some(stream_observation.clone());
                // A committed client prefix can never be retracted. This
                // request-level predicate only removes the whole-attempt
                // rewrites that are decided before the stream starts (memory
                // capture) or are scoped to a declared profile (thinking-tags).
                // The complete-attempt Direct response hook stays content
                // driven, so the collector's frame-level commit probe decides
                // the actual commit and the hook still runs after the terminal.
                // Tool declarations do not gate early commit: the probe already
                // holds any governed text (DSML labels and thinking markers)
                // before the terminal, and the complete-attempt owners only
                // rewrite content that carries those exact markers. The DSH
                // harness injects tools into every request and omits
                // `tool_choice`, so a declaration-based gate here would block
                // first-frame commit for all live traffic.
                let attempt_client_frame_sink = client_frame_sink.clone().filter(|_| {
                    !manifest.memory_raw_capture.enabled
                        && !response_projection.compat_plan.has_block(
                            crate::direct_response_hooks::V3DirectResponseCompatBlock::ThinkingTags,
                        )
                });
                let client_commit_probe = attempt_client_frame_sink.clone();
                let committed =
                    match direct_runtime_helpers_stream::project_and_collect_direct_sse_attempt(
                        stream,
                        stream_observation,
                        runtime_timing.clone(),
                        manifest,
                        &standardized.server_id,
                        &standardized.request_id,
                        retain_response_cipher,
                        &response_projection.compat_plan,
                        &direct_dsml_context,
                        ns_tool_identities.clone(),
                        &hook_registry,
                        &direct_failure_session_scope,
                        attempt_budget.clone(),
                        attempt_client_frame_sink,
                    )
                    .await
                    {
                        Ok(committed) => committed,
                        Err(Err(fault)) => {
                            if let Err(error) = runtime_timing.finish_external_if_active() {
                                return direct_runtime_helpers_stream::source_failure_output(
                                    runtime_source("V3RuntimeTimingExternal", error),
                                    last_external_http.clone(),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            if client_commit_probe
                                .as_ref()
                                .is_some_and(|sink| sink.is_committed())
                            {
                                return direct_runtime_helpers_stream::post_commit_client_transport_break_output(
                                    Err(fault),
                                    last_external_http.clone(),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            return direct_runtime_helpers_stream::source_failure_output(
                                Err(fault),
                                last_external_http.clone(),
                                trace,
                                &hook_registry,
                            );
                        }
                        Err(Ok(source))
                            if source.source_kind != V3ErrorSourceKind::ProviderFailure
                                && !routecodex_v3_error::is_v3_recoverable_response_processing_source(&source) =>
                        {
                            if let Err(error) = runtime_timing.finish_external_if_active() {
                                return direct_runtime_helpers_stream::source_failure_output(
                                    runtime_source("V3RuntimeTimingExternal", error),
                                    last_external_http.clone(),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            if client_commit_probe
                                .as_ref()
                                .is_some_and(|sink| sink.is_committed())
                            {
                                return direct_runtime_helpers_stream::post_commit_client_transport_break_output(
                                    Ok(source),
                                    last_external_http.clone(),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            return direct_runtime_helpers_stream::source_failure_output(
                                Ok(source),
                                last_external_http.clone(),
                                trace,
                                &hook_registry,
                            );
                        }
                        Err(Ok(source)) => {
                            let timing_failure = runtime_timing
                                .finish_external_if_active()
                                .err()
                                .map(|error| runtime_source("V3RuntimeTimingExternal", error));
                            if let Some(timing_failure) = timing_failure {
                                if client_commit_probe
                                    .as_ref()
                                    .is_some_and(|sink| sink.is_committed())
                                {
                                    return direct_runtime_helpers_stream::post_commit_client_transport_break_output(
                                        timing_failure,
                                        last_external_http.clone(),
                                        trace,
                                        &hook_registry,
                                    );
                                }
                                return direct_runtime_helpers_stream::source_failure_output(
                                    timing_failure,
                                    last_external_http.clone(),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            if client_commit_probe
                                .as_ref()
                                .is_some_and(|sink| sink.is_committed())
                            {
                                if let Err(node) = record_post_commit_direct_provider_failure(
                                    &provider_health,
                                    &direct_failure_session_scope,
                                    &policy.target,
                                    &source,
                                ) {
                                    trace.push(node);
                                }
                                return direct_runtime_helpers_stream::post_commit_client_transport_break_output(
                                    Ok(source),
                                    last_external_http.clone(),
                                    trace,
                                    &hook_registry,
                                );
                            }
                            // A provider SSE that ends without its protocol
                            // terminal is a recoverable provider failure. The
                            // policy reselects immediately when another
                            // candidate exists. Only the final failed attempt
                            // (ProjectTerminal, no replacement) stays pending
                            // until the declared residence deadline, without
                            // retrying or probing the failed identity.
                            let is_missing_terminal_provider_failure = source.source_kind
                                == V3ErrorSourceKind::ProviderFailure
                                && source
                                    .external_error
                                    .as_ref()
                                    .and_then(|external| external.code.as_deref())
                                    == Some("PROVIDER_RESPONSE_SSE_MISSING_TERMINAL");
                            let mut policy_result = match run_v3_direct_provider_failure_policy(
                                &V3DirectProviderFailurePolicyContext {
                                    failure_session_scope: &direct_failure_session_scope,
                                    provider_health: &provider_health,
                                    availability: &availability,
                                    expanded: expanded.as_ref(),
                                    provider_pinned: false,
                                    now_epoch_ms,
                                    manifest: &manifest,
                                },
                                &policy.target,
                                source,
                                provider_status,
                                &mut V3DirectProviderFailurePolicyState {
                                    failed_candidates: &mut failed_candidates,
                                    capacity_skipped: &capacity_skipped,
                                    trace: &mut trace,
                                },
                                last_external_http.as_ref(),
                            )
                            .await
                            {
                                Ok(result) => result,
                                Err(failure) => {
                                    return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                                        failure,
                                        last_external_http,
                                        trace,
                                        None,
                                    )
                                }
                            };
                            if let Err(failure) =
                                policy_result.exhaust_if_residence_expired(&attempt_budget)
                            {
                                return direct_runtime_helpers_stream::policy_failure_output_with_observability(
                                    failure,
                                    last_external_http,
                                    trace,
                                    None,
                                );
                            }
                            if let Some(event) = policy_result.event.clone() {
                                provider_failure_events.push(event.clone());
                                publish_v3_direct_provider_failure_event(
                                    provider_failure_event_sink.as_ref(),
                                    &policy.target,
                                    "responses",
                                    "sse",
                                    event.external_error_status,
                                    &provider_failure_events,
                                    &event,
                                    total_attempts(&accumulator, send_attempts),
                                );
                            }
                            match &policy_result.decision.action {
                                V3Error05ExecutionAction::ReevaluateTarget => {
                                    retry_selected = None;
                                    continue;
                                }
                                V3Error05ExecutionAction::WaitThenReselect { recovery } => {
                                    retry_selected = policy_result.retry_selected.map(|selected| *selected);
                                    continue;
                                }
                                V3Error05ExecutionAction::ProjectTerminal => {
                                    if is_missing_terminal_provider_failure {
                                        let deadline =
                                            tokio::time::Instant::from_std(
                                                attempt_budget.residence_deadline(),
                                            );
                                        if tokio::time::Instant::now() < deadline {
                                            tokio::time::sleep_until(deadline).await;
                                        }
                                    }
                                    let mut observability = build_v3_direct_runtime_observability(
                                        &policy.target,
                                        "responses",
                                        "sse",
                                        policy_result.event.as_ref().map(|event| event.status),
                                        "failed",
                                        provider_failure_events.clone(),
                                    );
                                    observability.attempts =
                                        Some(total_attempts(&accumulator, send_attempts));
                                    return direct_runtime_helpers_stream::provider_terminal_output(
                                        policy_result.decision,
                                        policy_result.terminal_disposition,
                                        last_external_http,
                                        trace,
                                        Some(observability),
                                        provider_request_snapshot,
                                        None,
                                    );
                                }
                                V3Error05ExecutionAction::ClientDisconnected => {
                                    return direct_runtime_helpers_stream::client_disconnect_terminal_output(
                                        policy_result.decision,
                                        trace,
                                        None,
                                    );
                                }
                                V3Error05ExecutionAction::RejectNonProviderError => {
                                    return direct_runtime_helpers_stream::source_failure_output(
                                        runtime_source(
                                            "V3Error05ExecutionDecision",
                                            "provider failure entered a non-provider Error05 lane",
                                        ),
                                        last_external_http.clone(),
                                        trace,
                                        &hook_registry,
                                    )
                                }
                            }
                        }
                    };
                let receipt = V3AttemptSuccessReceipt::from_sealed_sse_attempt(&committed);
                (V3ClientBody::CommittedSse(committed), receipt)
            }
            V3ProviderAttemptBody::Json(body) => (
                V3ClientBody::Json(body),
                V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
            ),
            V3ProviderAttemptBody::Bytes(body) => (
                V3ClientBody::Bytes(body),
                V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
            ),
        };
        let client_payload = V3Resp15ClientPayload {
            status: response_projection.attempt_payload.status,
            headers: std::mem::take(&mut response_projection.attempt_payload.headers),
            body: client_body,
        };
        let live_client_sse = matches!(&client_payload.body, V3ClientBody::Sse(_));
        if !live_client_sse && !committed_client_sse {
            let _ = &attempt_success_receipt;
        }
        if !provider_health_neutral {
            if let Err(source) = record_v3_direct_provider_success(
                &attempt_success_receipt,
                &provider_health,
                &direct_failure_session_scope,
                &policy.target,
                now_epoch_ms,
            ) {
                return direct_runtime_helpers_stream::source_failure_output(
                    source,
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                );
            }
        }
        if let Err(error) = commit_route_policy(&attempt_success_receipt) {
            return direct_runtime_helpers_stream::source_failure_output(
                runtime_source("V3Router06RoutePoolResolved", error),
                last_external_http.clone(),
                trace,
                &hook_registry,
            );
        }
        trace.push("V3DirectResp15ClientPayloadReady");
        trace.push("V3Resp15ClientPayload");
        let timing = match finish_v3_direct_runtime_timing(
            committed_client_sse,
            live_client_sse,
            response_projection.stream_observation.as_ref(),
            &runtime_timing,
        ) {
            Ok(timing) => timing,
            Err(source) => {
                return direct_runtime_helpers_stream::source_failure_output(
                    source,
                    last_external_http.clone(),
                    trace,
                    &hook_registry,
                )
            }
        };
        let mut observability = build_v3_direct_runtime_observability(
            &policy.target,
            "responses",
            v3_direct_client_transport_label(&client_payload),
            Some(provider_status),
            "completed",
            provider_failure_events.clone(),
        );
        observability.attempts = Some(total_attempts(&accumulator, send_attempts));
        observability.timing = timing;

        return V3ResponsesDirectRuntimeOutput {
            observability: Some(observability),
            terminal_disposition: None,
            diagnostic_source: None,
            diagnostic_cause: None,
            stream_observation: response_projection.stream_observation.clone(),
            client_payload,
            provider_request_snapshot,
            provider_response_snapshot,
            node_trace: trace,
            error_chain: None,
            protocol_relay_handoff: None,
        };
    }
}

include!("kernel/direct_runtime_helpers.rs");
include!("kernel/v3_direct_core.rs");
#[cfg(test)]
mod tests;
