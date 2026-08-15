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
    V3RelayProviderTargetResolutionInput,
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
#[path = "responses_relay_runtime_inner.rs"]
mod responses_relay_runtime_inner;
#[path = "responses_relay_types.rs"]
mod responses_relay_types;
pub(crate) use responses_relay_runtime_inner::{
    find_responses_tool_output_ids, V3ResponsesRelayToolOutputIds,
};
use responses_relay_runtime_inner::execute_v3_responses_relay_runtime_inner;
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

    pub fn store(&self) -> V3ProviderHealthStore {
        self.runtime_health.store()
    }

    pub fn runtime_health(&self) -> V3ProviderFailureRuntimeHealth {
        self.runtime_health.clone()
    }
}
use responses_openai_chat_conversion::*;
use responses_relay_dry_run::*;
use responses_relay_json_hooks::*;
pub use responses_relay_dry_run::{
    execute_v3_responses_relay_dry_run_runtime_with_local_continuation,
    execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control,
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
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
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
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
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
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
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
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
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
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
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
    continuation_disabled: bool,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(local) = local else {
        return Ok(());
    };
    if !local.commit_resp04_effects {
        return Ok(());
    }
    if continuation_disabled {
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
    strip_client_response_id: bool,
) -> V3ResponsesRelayClientBody {
    let mut finalized_response = finalized_response;
    if strip_client_response_id {
        crate::shared::strip_v3_response_id_from_json_body(&mut finalized_response);
    }
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
    let secret = match (&auth.env, &auth.token_file, &auth.secret_file, &auth.secret_key, &auth.api_key) {
        (Some(env), None, None, None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None, None, None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(path), Some(key), None) => V3ProviderAuthSecretHandle::SecretFile {
            path: path.clone(),
            key: key.clone(),
        },
        (None, None, None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
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
        compatibility_profile: provider.compatibility_profile.clone(),
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
    })
}



#[cfg(test)]
#[path = "responses_relay_runtime_tests.rs"]
mod responses_relay_runtime_tests;
#[cfg(test)]
#[path = "responses_relay_runtime_tests_extra.rs"]
mod responses_relay_runtime_tests_extra;
