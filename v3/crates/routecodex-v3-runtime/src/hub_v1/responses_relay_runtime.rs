use super::common::V3ChatProcessRefillDisposition;
use super::*;
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    expand_v3_relay_target_plan_for_selected, project_v3_client_disconnect,
    provider_runtime_failure_stage, run_v3_relay_provider_failure_policy,
    v3_relay_provider_policy_now_epoch_ms, v3_relay_provider_target_selection_sample,
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyState, V3RelayProviderFailureRetryPolicy,
    V3RelayProviderTargetResolutionInput, V3RuntimeProviderAdmission,
};
use crate::runtime_timing::{V3RuntimeObservabilityAccumulator, V3RuntimeTimingSummary};
use crate::{project_v3_debug_failure, V3ResponsesProtocolExecutionPlan};
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
    build_v3_provider_12_responses_wire_payload, v3_provider_auth_handle_from_manifest_entry,
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderAuthHandle, V3ProviderError,
    V3ProviderHealthListenerScope, V3ProviderHealthStore, V3ProviderResp14Raw,
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

#[path = "responses_openai_chat_conversion.rs"]
mod responses_openai_chat_conversion;
#[path = "responses_relay_dry_run.rs"]
mod responses_relay_dry_run;
#[path = "responses_relay_failures.rs"]
mod responses_relay_failures;
#[path = "responses_relay_json_hooks.rs"]
mod responses_relay_json_hooks;
#[path = "responses_relay_runtime_inner.rs"]
mod responses_relay_runtime_inner;
#[path = "responses_relay_types.rs"]
mod responses_relay_types;
use responses_relay_runtime_inner::{
    execute_v3_responses_relay_runtime_inner, execute_v3_responses_relay_runtime_inner_with_refill,
};
pub(crate) use responses_relay_runtime_inner::{
    find_responses_tool_output_ids, V3ResponsesRelayToolOutputIds,
};
pub use responses_relay_types::*;
// Provider health store 保持 opaque：health handle 归 Provider runtime boundary
//（worker 拆分时误入 types.rs，由 module-boundaries gate 强制移回）。
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

    pub fn from_manifest_for_listener(
        manifest: &V3Config05ManifestPublished,
        listener: &V3ProviderHealthListenerScope,
    ) -> Self {
        Self {
            runtime_health: V3ProviderFailureRuntimeHealth::from_manifest_for_listener(
                manifest, listener,
            ),
        }
    }

    pub fn from_manifest_without_persistence(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            runtime_health: V3ProviderFailureRuntimeHealth::from_manifest_for_tests(manifest),
        }
    }

    pub fn store(&self) -> V3ProviderHealthStore {
        self.runtime_health.store()
    }

    pub fn runtime_health(&self) -> V3ProviderFailureRuntimeHealth {
        self.runtime_health.clone()
    }

    pub fn flush_persistence(&self) -> Result<(), String> {
        self.runtime_health.store().flush_persistence()
    }

    pub fn persistence_alarm(&self) -> Option<String> {
        self.runtime_health.store().persistence_alarm()
    }
}
pub(super) use responses_openai_chat_conversion::build_v3_responses_provider_response_from_openai_chat_payload;
pub(crate) use responses_openai_chat_conversion::build_v3_responses_reasoning_item_from_openai_chat_message;
use responses_openai_chat_conversion::*;
use responses_relay_dry_run::*;
pub use responses_relay_dry_run::{
    execute_v3_responses_relay_dry_run_orchestration_outcome,
    project_v3_responses_relay_runtime_failure,
};
pub(crate) use responses_relay_failures::provider_response_stream_relay_failure;
use responses_relay_failures::{
    allowed_execution_modes_for_relay_server, error_output,
    is_v3_responses_provider_response_failure, provider_failure_output,
    provider_failure_output_with_observation, provider_http_failure,
    provider_request_relay_failure, provider_response_hook_failure,
    provider_response_stream_failure, provider_runtime_failure, server_routing_group,
    terminalize_v3_responses_relay_provider_failure,
};
use responses_relay_json_hooks::*;

const V3_RESPONSES_RELAY_PROVIDER_EVENT_EOF_WITHOUT_TERMINAL_MESSAGE: &str =
    "provider response event stream ended before response.completed";
const V3_RESPONSES_RELAY_PROVIDER_EVENT_FAILED_MESSAGE: &str =
    "provider response event stream failed before response.completed";
const V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER: &str = "ProviderRespInbound01Raw -> V3HubRespInbound02Normalized (Responses event codec; SSE transport is opaque framing)";
const V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER: &str =
    "V3HubRespOutbound05ClientSemantic -> V3ServerRespOutbound06ClientFrame";
pub async fn execute_v3_responses_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime(manifest, input, crate::default_responses_transport()).await
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
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_transport_health<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
        true,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds::default(),
    )
    .await
}

pub async fn execute_v3_responses_relay_runtime_with_default_transport_health(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    provider_health: &V3ResponsesRelayProviderHealthHandle,
    provider_snapshots: V3ResponsesRelayProviderSnapshotCapture,
    provider_failure_event_sink: Option<V3RuntimeProviderFailureEventSink>,
    route_selection_event_sink: Option<V3RuntimeRouteSelectionEventSink>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
    initial_request_local_excluded_candidates: BTreeSet<String>,
    initial_relay_seeds: V3ResponsesRelayRuntimeSeeds,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let transport = V3LiveSnapResponsesTransport::with_default_transport();
    let snapshots = transport.snapshots();
    let control = match initial_relay_seeds.request_execution_control.clone() {
        Some(control) => control,
        None => crate::nodes::V3RequestExecutionControl::from_manifest(manifest, &input.server_id)
            .map_err(|error| V3ResponsesRelayRuntimeError::ExecutionControl(error.to_string()))?,
    };
    let max_refills = v3_chat_process_refill_max_consecutive();
    let mut payload = input.payload.clone();
    let mut accumulated_items: Vec<Value> = Vec::new();
    let mut accumulated_usage: Option<V3RuntimeUsageSummary> = None;
    let mut accumulated_attempts: Option<usize> = None;
    let mut rounds = 0usize;
    loop {
        let mut seeds = initial_relay_seeds.clone();
        seeds.request_execution_control = Some(control.clone());
        if rounds > 0 {
            // The original client execution owns the route-policy commit. A
            // refill must not commit the same pending transaction twice.
            seeds.route_policy_pending = None;
            // Each execution owns an independent timing terminal. Reusing the
            // original accumulator would make the first refill's
            // `finish_runtime()` observe an already-finished state.
            seeds.observability_accumulator = None;
        }
        let execution_input = V3ResponsesRelayRuntimeInput {
            payload: payload.clone(),
            ..input.clone()
        };
        let invocation_source = if rounds == 0 {
            V3HubInvocationSource::Client
        } else {
            V3HubInvocationSource::Refill
        };
        let chat_process_refill = V3ResponsesRelayRefillSignal::default();
        let mut output = execute_v3_responses_relay_runtime_inner_with_refill(
            manifest,
            execution_input,
            &transport,
            provider_health.runtime_health(),
            V3ResponsesRelayRetryPolicy::from_manifest(manifest),
            true,
            provider_failure_event_sink.clone(),
            route_selection_event_sink.clone(),
            initial_selected_target.clone(),
            initial_expanded.clone(),
            initial_request_local_excluded_candidates.clone(),
            seeds,
            invocation_source,
            chat_process_refill.clone(),
        )
        .await?;
        let chat_process_refill = chat_process_refill.take();
        if let Some(attempts) = output
            .observability
            .as_ref()
            .and_then(|observability| observability.attempts)
        {
            accumulated_attempts = Some(accumulated_attempts.unwrap_or(0).saturating_add(attempts));
        }
        if chat_process_refill == Some(V3ChatProcessRefillDisposition::RequestRefill) {
            if let Some(finalized) = output.finalized_response.as_ref() {
                if let Ok(next_payload) =
                    build_v3_chat_process_refill_continuation_request(&payload, finalized)
                {
                    // Request-local cancellation witness: the control carries no
                    // independent cancel flag, so the residence deadline is the
                    // only one. An expired deadline delivers the current real
                    // result instead of launching another execution.
                    if control.deadline_unix_ms().is_ok() && control.try_admit_refill(max_refills) {
                        // A refill is a new execution of the Runtime mainline:
                        // it owns its own provider transport attempt allowance
                        // while the request-scoped refill budget and residence
                        // deadline stay unchanged.
                        control.begin_refill_execution();
                        accumulated_items
                            .extend(collect_v3_chat_process_business_output_items(finalized));
                        accumulate_v3_chat_process_refill_usage(
                            &mut accumulated_usage,
                            extract_v3_runtime_usage_summary(finalized),
                        );
                        payload = next_payload;
                        rounds += 1;
                        continue;
                    }
                }
            }
        }
        if rounds > 0 {
            if let Some(mut finalized) = output.finalized_response.take() {
                // The refill loop only accumulates usage when it launches the
                // next execution. Fold the final execution's usage in before
                // write-back so the delivered total covers every round.
                accumulate_v3_chat_process_refill_usage(
                    &mut accumulated_usage,
                    extract_v3_runtime_usage_summary(&finalized),
                );
                merge_v3_chat_process_refill_output_items(&mut finalized, &accumulated_items);
                if let Some(usage) = accumulated_usage.as_ref() {
                    write_v3_chat_process_refill_usage(&mut finalized, usage);
                }
                output.finalized_response = Some(finalized.clone());
                output.client_body = project_v3_responses_relay_client_body(
                    v3_responses_relay_transport_intent_from_stream_field(&input.payload),
                    finalized,
                    crate::shared::v3_strip_client_response_id_enabled_for_server(
                        manifest,
                        &input.server_id,
                    ),
                    control.attempt_budget(),
                )?;
            }
            if let Some(observability) = output.observability.as_mut() {
                if accumulated_usage.is_some() {
                    observability.usage = accumulated_usage.clone();
                }
                if accumulated_attempts.is_some() {
                    observability.attempts = accumulated_attempts;
                }
            }
        }
        output.provider_snapshots = Some(snapshots.into_payload(
            provider_snapshots.provider_request,
            provider_snapshots.provider_response,
        ));
        return Ok(output);
    }
}

pub async fn execute_v3_responses_relay_runtime_with_retry_policy<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    transport: &T,
    retry_policy: V3ResponsesRelayRetryPolicy,
) -> Result<V3ResponsesRelayRuntimeOutput, V3ResponsesRelayRuntimeError> {
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(manifest);
    execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        transport,
        provider_health.runtime_health(),
        retry_policy,
        true,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds::default(),
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
        provider_health.runtime_health(),
        retry_policy,
        true,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds::default(),
    )
    .await
}

async fn handle_v3_responses_relay_provider_failure(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    mut failure: V3ResponsesRelayProviderFailure,
    state: &mut V3ResponsesRelayProviderRetryState<'_>,
) -> Result<Option<V3ResponsesRelayProviderFailure>, V3ResponsesRelayRuntimeError> {
    if failure.terminal_projection.is_some() || failure.error_operator_fault.is_some() {
        return Ok(Some(failure));
    }
    let result = match crate::provider_failure_runtime_policy::run_v3_relay_provider_failure_policy_with_response_source(
        context,
        selected,
        failure.source_stage,
        failure.status,
        Some(failure.policy_error_type.clone()),
        v3_responses_relay_provider_failure_reason(&failure)
            .unwrap_or("provider failure")
            .to_string(),
        failure
            .matched_policy
            .as_ref()
            .map(V3ProviderFailureDirective::policy),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: state.failed_candidates,
            same_candidate_retries: state.same_candidate_retries,
            trace: state.trace,
            last_external_http: state.last_external_http,
        },
        failure.response_processing_code,
    )
    .await
    {
        Ok(result) => result,
        Err(Ok(error)) => return Err(V3ResponsesRelayRuntimeError::ProviderHealth(error)),
        Err(Err(fault)) => {
            failure.error_operator_fault = Some(fault);
            return Ok(Some(failure));
        }
    };
    // Carry the real upstream HTTP status (if any) into the policy event so the
    // failure observation can separate it from the client projection status.
    let mut policy_event = result.event.clone();
    policy_event.provider_status = failure.provider_status;
    policy_event.failed_attempt_evidence = failure.failed_attempt_evidence.clone();
    let event = build_v3_runtime_provider_failure_observation_from_policy_event(&policy_event);
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
            // 瞬态重试（request-local recovery witness，wait_ms=None）不经过
            // provider action gate：无 health 记录可等，立即重发。
            if result.event.wait_ms.is_some() {
                *state.pending_recovery = Some(recovery);
            } else {
                *state.pending_recovery = None;
            }
            Ok(None)
        }
        V3Error05ExecutionAction::ProjectTerminal => {
            failure.terminal_projection = result.terminal_projection;
            failure.terminal_disposition = result.terminal_disposition;
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

fn attach_v3_provider_failure_events_to_failure(
    mut failure: V3ResponsesRelayProviderFailure,
    provider_failure_events: &[V3RuntimeProviderFailureObservation],
) -> V3ResponsesRelayProviderFailure {
    if let Some(observability) = failure.observability.as_mut() {
        observability.provider_failure_events = provider_failure_events.to_vec();
    }
    failure
}

fn build_v3_relay_observability_from_selected(
    selected: &routecodex_v3_target::V3Target10ConcreteProviderSelected,
    transport_intent: V3HubTransportIntent,
) -> V3RuntimeObservability {
    // 唯一共享 relay observability 构建器（chat/gemini/anthropic 同源，
    // 禁止各 runtime 复制字段映射）。
    super::relay_runtime_shared::build_v3_relay_observability(
        "responses",
        selected,
        v3_transport_intent_label(transport_intent),
    )
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
    strip_client_response_id: bool,
    attempt_budget: crate::nodes::V3AttemptBudget,
) -> Result<V3ResponsesRelayClientBody, V3ResponsesRelayRuntimeError> {
    let mut finalized_response = finalized_response;
    if strip_client_response_id {
        crate::shared::strip_v3_response_id_from_json_body(&mut finalized_response);
    }
    match client_response_transport_intent {
        V3HubTransportIntent::Json => Ok(V3ResponsesRelayClientBody::Json(finalized_response)),
        V3HubTransportIntent::Sse => Ok(V3ResponsesRelayClientBody::Sse(
            build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(
                finalized_response,
                attempt_budget,
            )
            .map_err(V3ResponsesRelayRuntimeError::ExecutionControlResponse)?,
        )),
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

pub(crate) fn read_v3_runtime_finish_reason(value: &Value) -> Option<String> {
    read_v3_runtime_string_path(value, &["finish_reason"])
        .or_else(|| read_v3_runtime_string_path(value, &["finishReason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["stop_reason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["stopReason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["delta", "stop_reason"]))
        .or_else(|| read_v3_runtime_string_path(value, &["message", "stop_reason"]))
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
    _event_type: Option<&str>,
    response_status: Option<&str>,
) -> Option<String> {
    match response_status.map(str::trim) {
        Some(status) if status.eq_ignore_ascii_case("requires_action") => {
            Some("tool_calls".to_string())
        }
        _ => None,
    }
}

/// response.incomplete 终帧的 `incomplete_details.reason` -> 观测 finish_reason：
/// max_output_tokens -> length、content_filter -> content_filter；未知 reason
/// 原样记录（reason 本身就是可观测的终态信息，观测层不猜测语义）。
pub(crate) fn infer_v3_runtime_incomplete_finish_reason(
    event: &Value,
    event_type: Option<&str>,
) -> Option<String> {
    if event_type != Some("response.incomplete") {
        return None;
    }
    let reason = event
        .pointer("/response/incomplete_details/reason")
        .or_else(|| event.pointer("/incomplete_details/reason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())?;
    Some(match reason {
        "max_output_tokens" => "length".to_string(),
        "content_filter" => "content_filter".to_string(),
        other => other.to_string(),
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

pub(crate) fn extract_v3_runtime_usage_summary(value: &Value) -> Option<V3RuntimeUsageSummary> {
    // Responses/OpenAI Chat/Anthropic 均使用顶层 `usage`；Gemini 使用
    // `usageMetadata`。归一化在唯一共享提取器内完成，禁止各协议 runtime
    // 各自复制一份 usage 解析。
    let usage = value.get("usage").or_else(|| value.get("usageMetadata"))?;
    let mut summary = V3RuntimeUsageSummary {
        input_tokens: read_v3_usage_u64(usage, &["input_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["promptTokenCount"])),
        output_tokens: read_v3_usage_u64(usage, &["output_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["completion_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["candidatesTokenCount"])),
        total_tokens: read_v3_usage_u64(usage, &["total_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["totalTokenCount"])),
        cached_tokens: read_v3_usage_u64(usage, &["input_tokens_details", "cached_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens_details", "cached_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["cachedContentTokenCount"])),
        // Anthropic/MiniMax/glm-5.3: read and creation are independent counts.
        // We preserve them in dedicated fields so Admin/UI can compute the
        // hit rate from `cache_read_input_tokens / input_tokens` without
        // collapsing the two and without relying on the legacy OpenAI
        // `cached_tokens` sub-count assumption.
        cache_read_input_tokens: read_v3_usage_u64(usage, &["cache_read_input_tokens"])
            .or_else(|| read_v3_usage_u64(usage, &["input_tokens_details", "cached_read_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["input_tokens_details", "cache_read_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens_details", "cached_read_tokens"]))
            .or_else(|| read_v3_usage_u64(usage, &["prompt_tokens_details", "cache_read_tokens"])),
        cache_creation_input_tokens: read_v3_usage_u64(usage, &["cache_creation_input_tokens"])
            .or_else(|| {
                read_v3_usage_u64(
                    usage,
                    &["input_tokens_details", "cache_creation_input_tokens"],
                )
            })
            .or_else(|| read_v3_usage_u64(usage, &["input_tokens_details", "cached_write_tokens"]))
            .or_else(|| {
                read_v3_usage_u64(
                    usage,
                    &["prompt_tokens_details", "cache_creation_input_tokens"],
                )
            })
            .or_else(|| {
                read_v3_usage_u64(
                    usage,
                    &["prompt_tokens_details", "cached_creation_input_tokens"],
                )
            }),
    };
    if summary.total_tokens.is_none() {
        summary.total_tokens = summary
            .input_tokens
            .zip(summary.output_tokens)
            .and_then(|(input_tokens, output_tokens)| input_tokens.checked_add(output_tokens));
    }
    if summary.input_tokens.is_some()
        || summary.output_tokens.is_some()
        || summary.total_tokens.is_some()
        || summary.cached_tokens.is_some()
        || summary.cache_read_input_tokens.is_some()
        || summary.cache_creation_input_tokens.is_some()
    {
        Some(summary)
    } else {
        None
    }
}

pub(crate) fn materialize_v3_runtime_input_usage_estimate_from_request(
    response: &mut Value,
    request: &Value,
) {
    let Some(response_object) = response.as_object_mut() else {
        return;
    };
    // The estimate is a full BPE pass and is discarded whenever the provider
    // already reported `input_tokens`, so the reported value is checked first.
    if response_object
        .get("usage")
        .and_then(Value::as_object)
        .and_then(|usage| usage.get("input_tokens"))
        .and_then(Value::as_u64)
        .is_some_and(|tokens| tokens > 0)
    {
        return;
    }
    let estimated_input_tokens = crate::token_estimation::estimate_v3_request_tokens(request);
    if estimated_input_tokens == 0 {
        return;
    }
    let usage = response_object
        .entry("usage")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(usage_object) = usage.as_object_mut() else {
        return;
    };
    usage_object.insert(
        "input_tokens".to_string(),
        Value::from(estimated_input_tokens),
    );
    if let Some(output_tokens) = usage_object.get("output_tokens").and_then(Value::as_u64) {
        usage_object.insert(
            "total_tokens".to_string(),
            Value::from(estimated_input_tokens.saturating_add(output_tokens)),
        );
    }
}

fn read_v3_usage_u64(value: &Value, path: &[&str]) -> Option<u64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current
        .as_u64()
        .or_else(|| {
            current
                .as_i64()
                .and_then(|number| u64::try_from(number).ok())
        })
        .or_else(|| {
            current.as_f64().and_then(|number| {
                if !number.is_finite() || number < 0.0 {
                    return None;
                }
                let rounded = number.round();
                if (rounded - number).abs() > f64::EPSILON * 16.0 {
                    return None;
                }
                u64::try_from(rounded as i128).ok()
            })
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
pub fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(
    response: Value,
) -> Result<V3ResponsesRelayClientStream, String> {
    build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(
        response,
        crate::nodes::V3AttemptBudget::process_default(),
    )
}

pub(crate) fn build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(
    response: Value,
    attempt_budget: crate::nodes::V3AttemptBudget,
) -> Result<V3ResponsesRelayClientStream, String> {
    let _owner = V3_RESPONSES_RELAY_SSE_CLIENT_FRAME_PROJECTION_OWNER;
    let (_, stream) = super::execute_v3_operation_runner_response_frame_committed_client_sse(
        response,
        move |mut response| {
            materialize_v3_responses_terminal_usage(&mut response);
            let status = response.get("status").and_then(Value::as_str);
            // response.incomplete 是 Responses 协议合法终态（max_output_tokens 截断 /
            // content_filter 触发）：必须按协议投影 response.created + output_item.done
            // （部分输出）+ response.incomplete，禁止把它映射成 response.failed 丢弃部分
            // 输出；只有 status=failed 才是失败终态。
            //
            // Responses 客户端帧序列与 Direct 路径/上游 provider 保持一致：协议没有
            // `response.done` 事件，Chat Completions 的 `[DONE]` 终止符也不属于 Responses。
            // A paused provider turn retains response.in_progress at the end of this
            // exchange; it must not acquire a fabricated response.completed event.
            // 不得向 Responses 客户端追加非协议帧。
            let failed = status == Some("failed");
            let mut frames = Vec::new();
            if !failed {
                if let Some(response_id) = response.get("id").and_then(Value::as_str) {
                    // response.created/response.in_progress 承载“尚未产生输出”的响应快照：
                    // 与上游 provider 和 Direct 路径一致，status 为 in_progress、output 为空。
                    let progress_response =
                        build_v3_responses_client_progress_response(&response, response_id);
                    frames.push(build_v3_runtime_sse_json_frame(
                        "response.created",
                        &json!({
                            "type": "response.created",
                            "response": progress_response,
                        }),
                    ));
                    frames.push(build_v3_runtime_sse_json_frame(
                        "response.in_progress",
                        &json!({
                            "type": "response.in_progress",
                            "response": progress_response,
                        }),
                    ));
                    if let Some(output) = response.get("output").and_then(Value::as_array) {
                        let mut reasoning_progress_emitted = false;
                        for (index, item) in output.iter().enumerate() {
                            let projected_item =
                                project_v3_responses_client_event_output_item_done_item(item);
                            append_v3_responses_client_reasoning_progress_frames(
                                &mut frames,
                                response_id,
                                index,
                                &projected_item,
                                &mut reasoning_progress_emitted,
                            );
                            append_v3_responses_client_function_call_progress_frames(
                                &mut frames,
                                response_id,
                                index,
                                &projected_item,
                            )?;
                            frames.push(build_v3_runtime_sse_json_frame(
                                "response.output_item.done",
                                &json!({
                                    "type": "response.output_item.done",
                                    "response_id": response_id,
                                    "output_index": index,
                                    "item": projected_item,
                                }),
                            ));
                        }
                    }
                }
            }
            let terminal_frame_index;
            if failed {
                frames.push(build_v3_runtime_sse_json_frame(
                    "response.failed",
                    &json!({
                        "type": "response.failed",
                        "response": response,
                    }),
                ));
                terminal_frame_index = frames.len() - 1;
            } else {
                let terminal_response = project_v3_responses_client_completed_response(&response);
                let terminal_event = match status {
                    Some("incomplete") => "response.incomplete",
                    Some("in_progress") => "response.in_progress",
                    _ => "response.completed",
                };
                frames.push(build_v3_runtime_sse_json_frame(
                    terminal_event,
                    &json!({
                        "type": terminal_event,
                        "response": terminal_response,
                    }),
                ));
                terminal_frame_index = frames.len() - 1;
            }
            let mut committed =
                crate::nodes::V3CommittedClientSseBuilder::with_budget(attempt_budget)
                    .map_err(|error| error.to_string())?;
            for (index, frame) in frames.into_iter().enumerate() {
                committed.push(frame).map_err(|error| error.to_string())?;
                if index == terminal_frame_index {
                    committed
                        .mark_last_frame_as_terminal()
                        .map_err(|error| error.to_string())?;
                }
            }
            let stream = committed
                .seal_after_validated_terminal()
                .map_err(|error| error.to_string())?;
            Ok((response, stream))
        },
    )?;
    Ok(stream)
}

pub(crate) fn materialize_v3_responses_terminal_usage(response: &mut Value) {
    let Some(object) = response.as_object_mut() else {
        return;
    };
    let usage = object
        .entry("usage".to_owned())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !usage.is_object() {
        *usage = Value::Object(serde_json::Map::new());
    }
    let usage = usage
        .as_object_mut()
        .expect("usage was normalized to an object");
    usage
        .entry("input_tokens".to_owned())
        .or_insert(Value::from(0));
    usage
        .entry("output_tokens".to_owned())
        .or_insert(Value::from(0));
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    usage
        .entry("total_tokens".to_owned())
        .or_insert(Value::from(input.saturating_add(output)));
}

fn append_v3_responses_client_reasoning_progress_frames(
    frames: &mut Vec<Vec<u8>>,
    response_id: &str,
    output_index: usize,
    item: &Value,
    reasoning_progress_emitted: &mut bool,
) {
    if *reasoning_progress_emitted || item.get("type").and_then(Value::as_str) != Some("reasoning")
    {
        return;
    }
    let Some(reasoning) = item
        .get("summary")
        .and_then(Value::as_array)
        .and_then(|summary| {
            summary.iter().find_map(|part| {
                let text = part.get("text").and_then(Value::as_str)?;
                text.starts_with("调用工具 ").then_some(text)
            })
        })
    else {
        return;
    };
    *reasoning_progress_emitted = true;
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .unwrap_or("rcc_reason_tool_call");
    let added_item = json!({
        "id": item_id,
        "type": "reasoning",
        "status": "in_progress",
        "summary": []
    });
    frames.push(build_v3_runtime_sse_json_frame(
        "response.output_item.added",
        &json!({
            "type": "response.output_item.added",
            "response_id": response_id,
            "output_index": output_index,
            "item": added_item,
        }),
    ));
    frames.push(build_v3_runtime_sse_json_frame(
        "response.reasoning_summary_part.added",
        &json!({
            "type": "response.reasoning_summary_part.added",
            "response_id": response_id,
            "output_index": output_index,
            "item_id": item_id,
            "summary_index": 0,
            "part": {"type": "summary_text", "text": ""},
        }),
    ));
    frames.push(build_v3_runtime_sse_json_frame(
        "response.reasoning_summary_text.delta",
        &json!({
            "type": "response.reasoning_summary_text.delta",
            "response_id": response_id,
            "output_index": output_index,
            "item_id": item_id,
            "summary_index": 0,
            "delta": reasoning,
        }),
    ));
    frames.push(build_v3_runtime_sse_json_frame(
        "response.reasoning_summary_text.done",
        &json!({
            "type": "response.reasoning_summary_text.done",
            "response_id": response_id,
            "output_index": output_index,
            "item_id": item_id,
            "summary_index": 0,
            "text": reasoning,
        }),
    ));
    frames.push(build_v3_runtime_sse_json_frame(
        "response.reasoning_summary_part.done",
        &json!({
            "type": "response.reasoning_summary_part.done",
            "response_id": response_id,
            "output_index": output_index,
            "item_id": item_id,
            "summary_index": 0,
            "part": {"type": "summary_text", "text": reasoning},
        }),
    ));
}

fn append_v3_responses_client_function_call_progress_frames(
    frames: &mut Vec<Vec<u8>>,
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
    if item_type == Some("function_call") && item.get("arguments").is_some() {
        if let Some(object) = added_item.as_object_mut() {
            object.insert("arguments".to_string(), Value::String(String::new()));
        }
    }
    frames.push(build_v3_runtime_sse_json_frame(
        "response.output_item.added",
        &json!({
            "type": "response.output_item.added",
            "response_id": response_id,
            "output_index": output_index,
            "item": added_item,
        }),
    ));
    if item_type != Some("function_call") {
        return Ok(());
    }
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "Responses client projection function_call is missing call_id".to_string()
        })?;
    // Responses clients require the progress event's arguments field to be a
    // string. Preserve an imperfect provider tool call instead of converting
    // it into a 502: native string arguments pass through byte-for-byte;
    // structured arguments are deterministically encoded; an absent field is
    // kept absent without an invented parameter progress event. This does
    // not infer or alter toolreason fields or the command object.
    let arguments = match item.get("arguments") {
        Some(Value::String(arguments)) => arguments.clone(),
        Some(arguments @ (Value::Object(_) | Value::Array(_))) => serde_json::to_string(arguments)
            .map_err(|error| {
                format!("Responses client projection function_call arguments failed: {error}")
            })?,
        Some(value) => value.to_string(),
        None => return Ok(()),
    };
    frames.push(build_v3_runtime_sse_json_frame(
        "response.function_call_arguments.done",
        &json!({
            "type": "response.function_call_arguments.done",
            "response_id": response_id,
            "output_index": output_index,
            "call_id": call_id,
            "arguments": arguments,
        }),
    ));
    Ok(())
}

pub(super) fn project_v3_responses_client_event_output_item_done_item(item: &Value) -> Value {
    if item.get("type").and_then(Value::as_str) != Some("output_text") {
        return item.clone();
    }
    let mut content_part = item.clone();
    if let Some(text) = content_part.get_mut("text") {
        if !text.is_string() {
            *text = Value::String(text.to_string());
        }
    }
    if let Some(object) = content_part.as_object_mut() {
        object.remove("id");
    }
    let mut projected = json!({
        "type": "message",
        "role": "assistant",
        "content": [content_part],
    });
    if let Some(id) = item.get("id").cloned() {
        projected["id"] = id;
    }
    projected
}

/// `response.created`/`response.in_progress` 的响应快照：保留 provider 身份
/// 与模型字段，但按 Responses 协议把状态固定为 `in_progress`、清空 output
/// （此刻尚未产生任何输出条目），并清掉只在终态成立的字段。禁止在
/// in-progress 帧里携带终态 status、最终 output、usage 或 incomplete_details。
fn build_v3_responses_client_progress_response(response: &Value, response_id: &str) -> Value {
    let mut progress = response.clone();
    if let Some(object) = progress.as_object_mut() {
        object.insert("id".to_string(), Value::String(response_id.to_string()));
        object.insert(
            "status".to_string(),
            Value::String("in_progress".to_string()),
        );
        object.insert("output".to_string(), Value::Array(Vec::new()));
        // Candidate outcomes describe the terminal output positions. Defer
        // this business extension until a snapshot contains that output.
        object.remove("gemini_candidate_outcomes");
        object.insert("usage".to_string(), Value::Null);
        object.insert("incomplete_details".to_string(), Value::Null);
        object.remove("completed_at");
        object.remove("stop_details");
    }
    progress
}

/// SSE 事件级 completed/done 内嵌 response 的 item 表示投影：与
/// `output_item.done` 事件保持一致（output_text -> message 包裹），
/// 避免同一 SSE 流内同一 output 条目出现两种 client 语义。
pub(super) fn project_v3_responses_client_completed_response(response: &Value) -> Value {
    let mut projected = response.clone();
    if let Some(output) = projected.get_mut("output").and_then(Value::as_array_mut) {
        for item in output.iter_mut() {
            *item = project_v3_responses_client_event_output_item_done_item(item);
        }
    }
    projected
}

pub(super) fn selected_interface_has_responses_contract(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    interface_id: &str,
) -> bool {
    manifest
        .providers
        .get(provider_id)
        .and_then(|provider| provider.interfaces.get(interface_id))
        .and_then(|interface| interface.responses.as_ref())
        .is_some()
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
    let secret = v3_provider_auth_handle_from_manifest_entry(selected.auth_alias.clone(), auth)
        .map_err(V3ResponsesRelayRuntimeError::Target)?
        .secret;
    Ok(V3ResponsesProviderTarget {
        provider_id: selected.provider_id.clone(),
        interface_id: selected.interface_id.clone(),
        provider_type: selected.provider_type.clone(),
        base_url: selected.base_url.clone(),
        canonical_model_id: selected.model_id.clone(),
        wire_model: selected.wire_model.clone(),
        compatibility_profile: selected.compatibility_profile.clone(),
        headers: provider.headers.clone(),
        auth: V3ProviderAuthHandle {
            alias: selected.auth_alias.clone(),
            secret,
        },
        responses_transport: selected.responses_transport,
        websocket_v2_url: selected.websocket_v2_url.clone(),
        provider_request_cleanup: selected.provider_request_cleanup.clone(),
        request_timeout_ms: provider.request_timeout_ms,
        sse_first_frame_timeout_ms: provider.sse_first_frame_timeout_ms,
        initial_concurrency_budget: selected.initial_concurrency_budget,
        concurrency_acquire_timeout_ms: selected.concurrency_acquire_timeout_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_failure_runtime_policy::{
        resolve_v3_relay_target_outcome, V3RelayProviderTargetResolution,
    };
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

    fn operator_fault_manifest() -> V3Config05ManifestPublished {
        let source = r#"
version = 3
[servers.operator_fault]
bind = "127.0.0.1"
port = 5555
routing_group = "operator_fault"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "OPERATOR_FAULT_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
[route_groups.operator_fault.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key", priority = 1 }]
"#;
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(source).expect("operator-fault authoring"),
        )
        .expect("operator-fault manifest")
    }

    #[tokio::test]
    async fn responses_compat_other_none_uses_canonical_fallback_source() {
        let manifest = operator_fault_manifest();
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let failure_session_scope =
            V3ProviderFailureSessionScope::new("operator_fault", "operator_fault", "session")
                .expect("compat session scope");
        let selected = match resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
            manifest: &manifest,
            server_id: "operator_fault",
            failure_session_scope: &failure_session_scope,
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            body: &json!({"model": "gpt-test", "input": "hello"}),
            request_local_excluded_candidates: &BTreeSet::new(),
            provider_health: &health,
            now_ms: 0,
            deterministic_sample: 0,
        }) {
            V3RelayProviderTargetResolution::Selected(selected) => selected,
            _ => panic!("fixture must select its provider"),
        };
        let compat_error = classify_v3_provider_compat_error(
            "request",
            &V3ProviderCompatProfileId::Passthrough,
            "provider request compatibility failed".to_string(),
        );
        assert_eq!(
            compat_error.classification(),
            V3ProviderCompatErrorClassification::Other
        );
        let expected_message = format!("V3 Responses Relay provider compat failed: {compat_error}");
        let failure = provider_request_relay_failure(
            V3ResponsesRelayRuntimeError::ProviderCompat(compat_error),
            "primary",
            None,
        )
        .expect("Responses compat Other must defer to the provider failure policy");
        assert_eq!(failure.status, 502);
        assert_eq!(failure.source_stage, "ProviderReqCompat06ProviderCompat");
        assert_eq!(failure.policy_error_type, "provider_request_compat_error");
        assert_eq!(failure.policy_error_message, expected_message);
        assert!(failure.terminal_projection.is_none());
        assert!(failure.error_operator_fault.is_none());

        let context = V3RelayProviderFailurePolicyContext {
            manifest: &manifest,
            captured_target_09: None,
            failure_session_scope: failure_session_scope.clone(),
            provider_health: &health,
            retry_policy: V3RelayProviderFailureRetryPolicy::default(),
            deterministic_sample: 0,
        };
        let mut last_external_http = None;
        let mut failed_candidates = BTreeSet::new();
        let mut same_candidate_retries = BTreeMap::new();
        let mut retry_selected = None;
        let mut pending_recovery = None;
        let mut provider_failure_events = Vec::new();
        let selected_observability = V3RuntimeObservability::default();
        let mut trace = Vec::new();
        let mut state = V3ResponsesRelayProviderRetryState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            retry_selected: &mut retry_selected,
            pending_recovery: &mut pending_recovery,
            provider_failure_events: &mut provider_failure_events,
            provider_failure_event_sink: None,
            selected_observability: &selected_observability,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        };

        let output =
            handle_v3_responses_relay_provider_failure(&context, selected, failure, &mut state)
                .await
                .expect("compat Other must use the ordinary failure policy")
                .expect("single-candidate compat Other must terminate");
        let projected = output
            .terminal_projection
            .as_ref()
            .expect("compat Other must carry the canonical Error06 projection");
        let source = &projected.diagnostic_source;

        assert_eq!(
            source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure
        );
        assert_eq!(source.source_stage, "ProviderReqCompat06ProviderCompat");
        assert_eq!(source.code, "provider_request_compat_error");
        assert_eq!(source.message, expected_message);
        assert!(source.internal_error.is_none());
        let external = source
            .external_error
            .as_ref()
            .expect("ordinary failure policy must preserve provider identity");
        assert_eq!(
            external.kind,
            routecodex_v3_error::V3ExternalErrorKind::Provider
        );
        assert_eq!(external.status, None);
        assert_eq!(
            external.code.as_deref(),
            Some("provider_request_compat_error")
        );
        assert_eq!(external.provider_id.as_deref(), Some("primary"));
        assert_eq!(external.upstream_request_id, None);
        assert_eq!(external.message.as_deref(), Some(expected_message.as_str()));
        assert_eq!(
            projected.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
        assert!(output.error_operator_fault.is_none());
        assert_eq!(failed_candidates.len(), 1);
        assert!(same_candidate_retries.is_empty());
        assert!(retry_selected.is_none());
        assert!(pending_recovery.is_none());
        assert_eq!(provider_failure_events.len(), 1);
        assert!(
            health
                .store()
                .availability_for_session(
                    &failure_session_scope,
                    "primary",
                    Some("key"),
                    Some("gpt-test"),
                    u64::MAX,
                )
                .available
        );
    }

    #[tokio::test]
    async fn operator_fault_short_circuits_before_retry_health_and_candidate_mutation() {
        let manifest = operator_fault_manifest();
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let failure_session_scope =
            V3ProviderFailureSessionScope::new("operator_fault", "operator_fault", "session")
                .expect("operator-fault session scope");
        let selected = match resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
            manifest: &manifest,
            server_id: "operator_fault",
            failure_session_scope: &failure_session_scope,
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            body: &json!({"model": "gpt-test", "input": "hello"}),
            request_local_excluded_candidates: &BTreeSet::new(),
            provider_health: &health,
            now_ms: 0,
            deterministic_sample: 0,
        }) {
            V3RelayProviderTargetResolution::Selected(selected) => selected,
            _ => panic!("fixture must select its provider"),
        };
        let source = build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            "relay_error_projection_nonterminal",
            "Error06 SDK completed without a terminal client projection",
        );
        let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
            source,
            Ok(None),
        )
        .expect_err("missing Error06 must produce the actual typed SDK fault");
        let failure = V3ResponsesRelayProviderFailure {
            status: 502,
            provider_status: None,
            policy_error_type: "provider_request_compat_error".to_string(),
            policy_error_message: "operator fault must not enter provider policy".to_string(),
            provider_id: selected.candidate.provider_id.clone(),
            source_stage: "ProviderReqCompat06ProviderCompat",
            observability: None,
            terminal_projection: None,
            terminal_disposition: None,
            error_operator_fault: Some(fault.clone()),
            failed_attempt_evidence: None,
            matched_policy: None,
            response_processing_code: None,
        };
        let context = V3RelayProviderFailurePolicyContext {
            manifest: &manifest,
            captured_target_09: None,
            failure_session_scope: failure_session_scope.clone(),
            provider_health: &health,
            retry_policy: V3RelayProviderFailureRetryPolicy::default(),
            deterministic_sample: 0,
        };
        let mut last_external_http = None;
        let mut failed_candidates = BTreeSet::new();
        let mut same_candidate_retries = BTreeMap::new();
        let mut retry_selected = None;
        let mut pending_recovery = None;
        let mut provider_failure_events = Vec::new();
        let selected_observability = V3RuntimeObservability::default();
        let mut trace = Vec::new();
        let mut state = V3ResponsesRelayProviderRetryState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            retry_selected: &mut retry_selected,
            pending_recovery: &mut pending_recovery,
            provider_failure_events: &mut provider_failure_events,
            provider_failure_event_sink: None,
            selected_observability: &selected_observability,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        };

        let output =
            handle_v3_responses_relay_provider_failure(&context, selected, failure, &mut state)
                .await
                .expect("operator fault must exit without a policy error");

        let output = output.expect("operator fault must remain terminal");
        assert_eq!(output.error_operator_fault, Some(fault));
        assert!(
            output.terminal_projection.is_none(),
            "seeded operator fault must not become a client projection"
        );
        assert!(failed_candidates.is_empty());
        assert!(same_candidate_retries.is_empty());
        assert!(retry_selected.is_none());
        assert!(pending_recovery.is_none());
        assert!(provider_failure_events.is_empty());
        assert!(trace.is_empty());
        assert!(
            health
                .store()
                .availability_for_session(
                    &failure_session_scope,
                    "primary",
                    Some("key"),
                    Some("gpt-test"),
                    u64::MAX,
                )
                .available
        );
    }
}

#[cfg(test)]
#[path = "responses_relay_runtime_multi_interface_tests.rs"]
mod responses_relay_runtime_multi_interface_tests;
#[cfg(test)]
#[path = "responses_relay_runtime_tests.rs"]
mod responses_relay_runtime_tests;
#[cfg(test)]
#[path = "responses_relay_runtime_tests_extra.rs"]
mod responses_relay_runtime_tests_extra;

#[cfg(test)]
#[path = "responses_relay_runtime_failure_propagation_test.rs"]
mod responses_relay_runtime_failure_propagation_test;

#[cfg(test)]
#[path = "responses_relay_output_cap_tests.rs"]
mod responses_relay_output_cap_tests;
