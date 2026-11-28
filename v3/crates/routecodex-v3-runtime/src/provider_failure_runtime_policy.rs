use futures_util::stream::{FuturesUnordered, StreamExt};
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ProviderDispositionStepManifest,
    V3ProviderErrorActionPolicyManifest, V3ProviderErrorActionScope,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_01_source_raised_internal, build_v3_provider_failure_action_from_v3_error_02,
    build_v3_provider_global_failure_policy, is_v3_provider_pool_exhausted, V3Error01SourceRaised,
    V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorSourceKind, V3ExternalErrorKind,
    V3ExternalErrorLink, V3ProviderFailureSessionScope, V3ProviderHealthScope,
};
use routecodex_v3_provider_responses::{
    adaptive_concurrency::V3AdaptiveConcurrencyController, V3ProviderAvailabilityProjection,
    V3ProviderAvailabilityReader, V3ProviderError, V3ProviderFailureAction,
    V3ProviderFailureCooldownScope, V3ProviderFailurePolicy, V3ProviderFailureRecord,
    V3ProviderHealthListenerScope, V3ProviderHealthStore, V3ProviderKeyHealthProjection,
    V3ProviderRecoveryKind, V3ProviderSchedulingProjection, V3ProviderSchedulingReader,
    V3ProviderSessionAvailabilityReader, V3ResponsesProviderTarget,
};
use routecodex_v3_target::{
    V3ActiveKeySelectionContext, V3StickySelectionScope, V3Target09CandidateSetExpanded,
    V3Target10ConcreteProviderSelected, V3TargetCandidate, V3TargetExhaustion, V3TargetInterpreter,
};
use routecodex_v3_virtual_router::{V3Router07OpaqueTargetHitOnce, V3VirtualRouter};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::hub_v1::V3RuntimeProviderFailedAttemptEvidence;
use crate::operation_runner::{
    run_v3_err01_source_raised_operator, run_v3_error_02_to_05_decision_operators,
    run_v3_error_06_terminal_projection_operator, V3Err01SourceInput,
};
use crate::provider_action_gate::{
    V3ProviderActionAdmission, V3ProviderActionFailureRecorded, V3ProviderActionGate,
    V3ProviderActionGateKey, V3ProviderActionProviderScope,
};
use crate::provider_error_policy_matching::provider_error_policy_matches_source_failure;
pub use crate::provider_failure_global_probe::build_v3_provider_global_probe_target;
pub(crate) use crate::provider_failure_global_probe::probe_v3_provider_global_target_impl;

struct V3ProviderProbeCancellationGuard {
    store: V3ProviderHealthStore,
    permit: routecodex_v3_provider_responses::V3ProviderHealthProbePermit,
}

const V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY: usize = 4;

#[derive(Debug)]
pub enum V3ProviderHealthProbeFailure {
    Provider(V3ProviderError),
    Internal(String),
    ConcurrencyBusy,
}

fn execute_provider_health_probe<F, Fut>(
    store: V3ProviderHealthStore,
    permit: routecodex_v3_provider_responses::V3ProviderHealthProbePermit,
    probe: F,
) -> impl Future<
    Output = (
        V3ProviderProbeCancellationGuard,
        Result<(), V3ProviderHealthProbeFailure>,
    ),
>
where
    F: Fn(String, String, Option<String>, Option<String>) -> Fut,
    Fut: Future<Output = Result<(), V3ProviderHealthProbeFailure>>,
{
    let provider_id = permit.provider_id().to_string();
    let interface_id = permit.interface_id().to_string();
    let auth_alias = permit.auth_alias().map(str::to_string);
    let model_id = permit.model_id().map(str::to_string);
    let cancellation = V3ProviderProbeCancellationGuard { store, permit };
    async move {
        let result = probe(
            provider_id.clone(),
            interface_id.clone(),
            auth_alias.clone(),
            model_id.clone(),
        )
        .await;
        (cancellation, result)
    }
}

impl Drop for V3ProviderProbeCancellationGuard {
    fn drop(&mut self) {
        let _ = self.store.cancel_provider_cooldown_probe(&self.permit);
    }
}

pub async fn probe_v3_provider_global_target(
    target: V3ResponsesProviderTarget,
) -> Result<(), V3ProviderHealthProbeFailure> {
    probe_v3_provider_global_target_impl(target).await
}

/// Resolve the typed health action for the complete provider identity.
/// Store owns consecutive observations and cooldown state.
pub(crate) fn apply_v3_internal_provider_failure_policy(
    mut action: V3ProviderFailureAction,
    source_stage: &str,
    status: u16,
    code: &str,
) -> V3ProviderFailureAction {
    let _ = (source_stage, code);
    if matches!(
        action.recovery,
        V3ProviderRecoveryKind::NotProviderHealth | V3ProviderRecoveryKind::HealthNeutralTransient
    ) {
        return action;
    }
    // 状态码阈值只作用在可恢复类：已注册的不可恢复账户/计费代码即使上游返回
    // 503 等可恢复状态，也必须保持首次冷却。
    if action.recovery != V3ProviderRecoveryKind::IrrecoverableGlobalCooldown {
        if let Some(policy) = build_v3_provider_global_failure_policy(status) {
            action.failure_threshold = policy.failure_threshold;
            action.cooldown_ms = policy.cooldown_ms;
            action.long_probe_backoff = matches!(status, 401 | 402 | 403 | 503);
            action.scope = V3ProviderHealthScope::GlobalProviderKey;
            return action;
        }
    }
    if action.failure_threshold == 0 {
        // Error owns the shared recoverable threshold; terminal policy stays
        // declared in internal.toml.
        let internal = routecodex_v3_config::internal::v3_internal_error_handling();
        action.failure_threshold = match action.recovery {
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown => {
                internal.unrecoverable_failure_threshold
            }
            V3ProviderRecoveryKind::RecoverableCounted => {
                routecodex_v3_error::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
            }
            _ => 0,
        };
    }
    action
}

pub(crate) fn provider_runtime_failure_stage(error: &V3ProviderError) -> &'static str {
    match error {
        V3ProviderError::UnexpectedContentType { .. }
        | V3ProviderError::ResponseBody { .. }
        | V3ProviderError::MalformedSse { .. }
        | V3ProviderError::WebSocketProtocol { .. }
        | V3ProviderError::WebSocketProviderEvent { .. } => "V3ProviderRespInbound01Raw",
        _ => "V3ProviderReqOutbound09TransportRequest",
    }
}

/// Request/provider compatibility failures are health-neutral. Exclusion is
/// exact-identity for every failure class; this classifier only decides whether
/// the exact failed identity is recorded in provider health.
pub(crate) fn is_health_neutral_request_compat_failure(
    source_stage: &str,
    error_type: Option<&str>,
) -> bool {
    source_stage == "ProviderReqCompat06ProviderCompat"
        || error_type == Some("provider_request_compat_error")
        // Provider semantic invalid-request responses describe this request,
        // not provider health. Relay may surface them as a runtime 502 after
        // decoding an HTTP-200 SSE error event, so status alone is insufficient.
        || error_type == Some("invalid_request_error")
        // Transport / response-header timeouts switch provider directly without
        // locking the provider out in a 1-hour health cooldown.
        || matches!(
            error_type,
            Some(
                "provider_response_header_timeout"
                    | "provider_request_budget_exhausted"
                    | "provider_timeout"
                    | "provider_transport_error"
            )
        )
}

/// A Relay Error-operator contract failure. This is a typed control resource:
/// the SDK did not produce a usable Error06, and the original Source remains
/// available as evidence when it already existed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RelayErrorOperatorFault {
    pub policy_failure: Box<V3Error01SourceRaised>,
    pub original_source: Option<Box<V3Error01SourceRaised>>,
}

/// Run the canonical Source01 SDK once and preserve its two successful side
/// outputs. If the SDK cannot raise the source, keep the reconstructed origin
/// as diagnostic evidence and report the SDK failure separately.
pub(crate) fn raise_v3_source_via_err01(
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: impl Into<String>,
    message: impl Into<String>,
    source_input: V3Err01SourceInput,
) -> Result<(Value, V3Error01SourceRaised), V3RelayErrorOperatorFault> {
    let code = code.into();
    let message = message.into();
    let original_source = match &source_input {
        V3Err01SourceInput::Plain => build_v3_error_01_source_raised(
            source_kind.clone(),
            source_stage,
            code.clone(),
            message.clone(),
        ),
        V3Err01SourceInput::Internal(internal_code) => build_v3_error_01_source_raised_internal(
            source_kind.clone(),
            source_stage,
            code.clone(),
            message.clone(),
            *internal_code,
        ),
        V3Err01SourceInput::External(external_error) => build_v3_error_01_source_raised_external(
            source_kind.clone(),
            source_stage,
            code.clone(),
            message.clone(),
            external_error.clone(),
        ),
    };

    run_v3_err01_source_raised_operator(source_kind, source_stage, code, message, source_input)
        .map_err(|runner_error| {
            relay_error_operator_fault_from_err01_source(
                source_stage,
                original_source,
                runner_error,
            )
        })
}

fn relay_error_operator_fault(
    code: &str,
    message: impl Into<String>,
    original_source: Option<V3Error01SourceRaised>,
) -> V3RelayErrorOperatorFault {
    V3RelayErrorOperatorFault {
        policy_failure: Box::new(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Error06ClientProjected",
            code,
            message,
        )),
        original_source: original_source.map(Box::new),
    }
}

pub(crate) fn relay_error_operator_fault_from_err01_source(
    source_stage: &'static str,
    original_source: V3Error01SourceRaised,
    runner_error: crate::operation_runner::OperationRunnerError,
) -> V3RelayErrorOperatorFault {
    V3RelayErrorOperatorFault {
        policy_failure: Box::new(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Error01SourceRaised",
            "err01_source_operator_sdk_failure",
            format!(
                "Err01 operator failed ({}) while raising {source_stage}:{}",
                runner_error.message, original_source.code
            ),
        )),
        original_source: Some(Box::new(original_source)),
    }
}

/// Convert the canonical Error06 SDK result without inventing a projection or
/// recursively invoking the SDK. Both an SDK error and a missing terminal
/// projection are typed operator faults.
pub(crate) fn finish_v3_relay_error_projection(
    original_source: V3Error01SourceRaised,
    result: Result<
        Option<(Value, V3Error06ClientProjected)>,
        crate::operation_runner::OperationRunnerError,
    >,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    match result {
        Ok(Some((_, projected))) => Ok(projected),
        Ok(None) => Err(relay_error_operator_fault(
            "relay_error_projection_nonterminal",
            "Error06 SDK completed without a terminal client projection",
            Some(original_source),
        )),
        Err(error) => Err(relay_error_operator_fault(
            "relay_error_operator_sdk_failure",
            error.message,
            Some(original_source),
        )),
    }
}

pub(crate) fn project_v3_relay_error_source(
    source: V3Error01SourceRaised,
    scope: V3ErrorActionScope,
    candidates_remaining: usize,
    source_status: Option<u16>,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    let source_projection = serde_json::to_value(&source).map_err(|error| {
        relay_error_operator_fault(
            "relay_error_operator_sdk_failure",
            format!("failed to serialize V3Error01SourceRaised: {error}"),
            Some(source.clone()),
        )
    })?;
    project_v3_relay_error_source_with_projection(
        source,
        source_projection,
        scope,
        candidates_remaining,
        source_status,
    )
}

fn project_v3_relay_error_source_with_projection(
    source: V3Error01SourceRaised,
    source_projection: Value,
    scope: V3ErrorActionScope,
    candidates_remaining: usize,
    source_status: Option<u16>,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    let original_source = source.clone();
    let (decision_projection, decision) = run_v3_error_02_to_05_decision_operators(
        source_projection,
        source,
        scope,
        candidates_remaining,
        false,
        false,
        None,
    )
    .map_err(|error| {
        relay_error_operator_fault(
            "relay_error_operator_sdk_failure",
            error.message,
            Some(original_source.clone()),
        )
    })?;
    let mut projected = finish_v3_relay_error_projection(
        original_source.clone(),
        run_v3_error_06_terminal_projection_operator(decision_projection, decision),
    )?;

    let internal_runtime_failure = original_source.source_kind == V3ErrorSourceKind::RuntimeFailure;
    let target_pool_exhausted =
        original_source.source_kind == V3ErrorSourceKind::TargetPoolExhausted;
    if !internal_runtime_failure && !target_pool_exhausted {
        let linked_status = projected
            .body
            .pointer("/error/external_error/status")
            .and_then(serde_json::Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .filter(|status| *status >= 400);
        if let Some(status) = source_status
            .filter(|status| *status >= 400)
            .or(linked_status)
        {
            projected.status = status;
        }
    }

    Ok(projected)
}

pub(crate) fn project_v3_client_disconnect(
    provider_id: &str,
    source_stage: &'static str,
    message: impl Into<String>,
) -> Result<V3Error06ClientProjected, V3RelayErrorOperatorFault> {
    let message = message.into();
    let (source_projection, source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::ClientDisconnect,
        source_stage,
        "client_disconnect",
        message.clone(),
        V3Err01SourceInput::Plain,
    )?;
    let original_source = source.clone();
    let (decision_projection, decision) = run_v3_error_02_to_05_decision_operators(
        source_projection,
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: provider_id.to_string(),
        },
        0,
        false,
        false,
        None,
    )
    .map_err(|error| {
        relay_error_operator_fault(
            "relay_error_operator_sdk_failure",
            error.message,
            Some(original_source.clone()),
        )
    })?;
    finish_v3_relay_error_projection(
        original_source,
        run_v3_error_06_terminal_projection_operator(decision_projection, decision),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct V3RelayProviderFailureRetryPolicy {
    pub(crate) same_candidate_retries: usize,
}

impl V3RelayProviderFailureRetryPolicy {
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        // Every provider failure changes the candidate. RetrySame is retained
        // only as a config compatibility enum and never grants production
        // same-candidate retries.
        let _ = manifest;
        Self {
            same_candidate_retries: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3RelayProviderFailurePolicyEvent {
    pub(crate) candidate: V3TargetCandidate,
    pub(crate) status: u16,
    /// The upstream provider's real HTTP status; `None` when no HTTP response was
    /// received. Distinct from `status`, which is the observed/projection status.
    pub(crate) provider_status: Option<u16>,
    pub(crate) error_type: Option<String>,
    pub(crate) message: String,
    pub(crate) health_record: V3ProviderFailureRecord,
    pub(crate) action: String,
    pub(crate) next_provider_key: Option<String>,
    pub(crate) wait_ms: Option<u64>,
    /// The original typed Error01 source of the provider attempt that started
    /// this policy run. It is carried so a later target-resolution failure can
    /// never erase the provider cause that actually began the attempt.
    pub(crate) diagnostic_source: V3Error01SourceRaised,
    /// Attempt-local transport evidence attached beside the typed failure. It is
    /// diagnostic only and never participates in policy decisions.
    pub(crate) failed_attempt_evidence: Option<Arc<V3RuntimeProviderFailedAttemptEvidence>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3RelayProviderFailurePolicyResult {
    pub(crate) business_trial_failed: bool,
    pub(crate) decision: V3Error05ExecutionDecision,
    pub(crate) retry_selected: Option<Box<V3Target10ConcreteProviderSelected>>,
    pub(crate) terminal_projection: Option<V3Error06ClientProjected>,
    pub(crate) terminal_disposition: Option<routecodex_v3_error::V3ProviderTerminalDisposition>,
    pub(crate) event: V3RelayProviderFailurePolicyEvent,
}

pub(crate) struct V3RelayProviderFailurePolicyContext<'ctx> {
    pub(crate) manifest: &'ctx V3Config05ManifestPublished,
    pub(crate) captured_target_09: Option<&'ctx V3Target09CandidateSetExpanded>,
    pub(crate) failure_session_scope: V3ProviderFailureSessionScope,
    pub(crate) provider_health: &'ctx V3ProviderFailureRuntimeHealth,
    pub(crate) recovery_control: Option<&'ctx crate::execution_control::V3RequestExecutionControl>,
    pub(crate) retry_policy: V3RelayProviderFailureRetryPolicy,
    pub(crate) deterministic_sample: u64,
}

pub(crate) struct V3RelayProviderFailurePolicyState<'state> {
    pub(crate) failed_candidates: &'state mut BTreeSet<String>,
    pub(crate) same_candidate_retries: &'state mut BTreeMap<String, usize>,
    pub(crate) trace: &'state mut Vec<&'static str>,
    pub(crate) last_external_http: &'state mut Option<routecodex_v3_error::V3ExternalHttpWitness>,
}

pub(crate) struct V3RelayProviderTargetResolutionInput<'input> {
    pub(crate) manifest: &'input V3Config05ManifestPublished,
    pub(crate) server_id: &'input str,
    pub(crate) entry_kind: &'input str,
    pub(crate) endpoint_path: &'input str,
    pub(crate) body: &'input Value,
    pub(crate) request_local_excluded_candidates: &'input BTreeSet<String>,
    pub(crate) failure_session_scope: &'input V3ProviderFailureSessionScope,
    pub(crate) provider_health: &'input V3ProviderFailureRuntimeHealth,
    pub(crate) now_ms: u64,
    pub(crate) deterministic_sample: u64,
}

pub(crate) enum V3RelayProviderTargetResolution {
    Selected(V3Target10ConcreteProviderSelected),
    Exhausted { attempted_candidates: Vec<String> },
    Failed(V3RelayProviderTargetResolutionFailure),
    OperatorFault(V3RelayErrorOperatorFault),
}

/// A target-resolution failure carries both side outputs from the canonical
/// Err01 node: the typed source used by the decision operators and the exact
/// projection that node emitted. The projection must not be reconstructed by
/// serializing the source at a later stage.
#[derive(Debug, Clone)]
pub(crate) struct V3RelayProviderTargetResolutionFailure {
    pub(crate) projection: Value,
    pub(crate) source: routecodex_v3_error::V3Error01SourceRaised,
}

enum V3RelayProviderSuccessorObservation {
    Eligible {
        candidate: V3TargetCandidate,
        default_pool: bool,
    },
    Resolution(V3RelayProviderTargetResolution),
}

/// Observe captured occurrence eligibility without selecting, assigning sticky
/// affinity or consuming an active queue turn.
pub(crate) fn observe_v3_target_successors(
    expanded: &V3Target09CandidateSetExpanded,
    session: &dyn V3ProviderAvailabilityReader,
    health: &V3ProviderFailureRuntimeHealth,
    failed: &BTreeSet<String>,
    scope: &V3ProviderFailureSessionScope,
    keys: Option<&routecodex_v3_target::V3ActiveKeySelectionState>,
    now_ms: u64,
) -> Vec<routecodex_v3_target::V3TargetOccurrenceEligibility> {
    let mut expanded = expanded.clone();
    if expanded.route.estimated_history_turns.is_some() {
        expanded.candidates.retain(|candidate| {
            !health.provider_blocked_until_compact(scope, &candidate.provider_id)
        });
    }
    let excluded = expanded
        .candidates
        .iter()
        .filter(|candidate| failed.contains(&v3_relay_provider_candidate_key(candidate)))
        .map(V3TargetCandidate::active_key_identity)
        .collect();
    let active = keys.map(|state| V3ActiveKeySelectionContext {
        listener_id: scope.server_id(),
        session_id: scope.is_client_session().then_some(scope.session_id()),
        state,
        excluded: &excluded,
    });
    let reader = V3SessionGlobalSchedulingReader {
        session,
        global: health,
        excluded: failed,
    };
    V3TargetInterpreter::default().observe_eligible_occurrences(
        &expanded,
        &reader,
        now_ms,
        &excluded,
        scope.server_id(),
        active.as_ref(),
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3SelectionInvalidation {
    OccurrenceChanged,
    HealthUnavailable,
}

pub(crate) fn selection_invalidation(
    selected: &V3Target10ConcreteProviderSelected,
    expanded: &V3Target09CandidateSetExpanded,
    keys: Option<&routecodex_v3_target::V3ActiveKeySelectionState>,
    health: &V3ProviderFailureRuntimeHealth,
    session: &V3ProviderFailureSessionScope,
    now_ms: u64,
) -> Option<V3SelectionInvalidation> {
    let captured = expanded.candidates.iter().any(|candidate| {
        candidate.active_key_identity() == selected.candidate.active_key_identity()
            && candidate.occurrences.contains(&selected.occurrence)
    });
    if !captured
        || !V3TargetInterpreter::candidate_admitted(&selected.candidate, now_ms)
        || (expanded.route.estimated_history_turns.is_some()
            && health.provider_blocked_until_compact(session, &selected.candidate.provider_id))
    {
        return Some(V3SelectionInvalidation::OccurrenceChanged);
    }
    if expanded
        .active_pools
        .contains_key(&selected.occurrence.pool_id)
    {
        let (Some(keys), Some(witness)) = (keys, selected.active_selection.as_ref()) else {
            return Some(V3SelectionInvalidation::OccurrenceChanged);
        };
        if witness.scope.listener_id != session.server_id()
            || witness.scope.routing_group_id != expanded.route.routing_group_id
            || witness.scope.pool_id != selected.occurrence.pool_id
            || witness.identity != selected.candidate.active_key_identity()
        {
            return Some(V3SelectionInvalidation::OccurrenceChanged);
        }
        active_selection_invalidation(witness, &selected.candidate, keys, health, session, now_ms)
    } else {
        selected
            .active_selection
            .is_some()
            .then_some(V3SelectionInvalidation::OccurrenceChanged)
    }
}

/// Revalidate selection after recovery acquisition without rejecting the
/// request's own health trial. A rejected send releases matching custody.
pub(crate) fn prepare_selected_dispatch(
    selected: &V3Target10ConcreteProviderSelected,
    expanded: Option<&V3Target09CandidateSetExpanded>,
    keys: Option<&routecodex_v3_target::V3ActiveKeySelectionState>,
    mut episode: Option<&mut routecodex_v3_target::V3ActiveKeyEpisode>,
    control: &crate::execution_control::V3RequestExecutionControl,
    health: &V3ProviderFailureRuntimeHealth,
    session: &V3ProviderFailureSessionScope,
    exclusions: &mut BTreeSet<String>,
    now_ms: u64,
) -> Result<bool, String> {
    let started = std::time::Instant::now();
    let candidate = &selected.candidate;
    let failed_retry = episode
        .as_ref()
        .is_some_and(|episode| episode.can_retry(true));
    if let Some(reason) = expanded.and_then(|expanded| {
        selection_invalidation(selected, expanded, keys, health, session, now_ms)
    }) {
        if failed_retry || reason == V3SelectionInvalidation::HealthUnavailable {
            exclusions.insert(v3_relay_provider_candidate_key(candidate));
        }
        return Ok(false);
    }
    if !health.acquire_business_recovery_trial(
        control,
        &candidate.provider_id,
        &candidate.interface_id,
        &candidate.auth_alias,
        &candidate.model_id,
        now_ms,
    )? {
        exclusions.insert(v3_relay_provider_candidate_key(candidate));
        return Ok(false);
    }
    if selected.route.estimated_history_turns.is_some()
        && health.provider_blocked_until_compact(session, &candidate.provider_id)
    {
        control
            .cancel_business_recovery_trial(
                &candidate.provider_id,
                &candidate.interface_id,
                &candidate.auth_alias,
                &candidate.model_id,
            )
            .map_err(|error| error.to_string())?;
        if let Some(episode) = episode.as_deref_mut() {
            episode.cancel();
        }
        exclusions.insert(v3_relay_provider_candidate_key(candidate));
        return Ok(false);
    }
    let ready = begin_v3_active_dispatch(
        selected,
        keys,
        episode,
        control,
        now_ms.saturating_add(started.elapsed().as_millis() as u64),
    )?;
    if !ready && failed_retry {
        exclusions.insert(v3_relay_provider_candidate_key(candidate));
    }
    Ok(ready)
}

pub(crate) fn begin_v3_active_dispatch(
    selected: &V3Target10ConcreteProviderSelected,
    keys: Option<&routecodex_v3_target::V3ActiveKeySelectionState>,
    mut episode: Option<&mut routecodex_v3_target::V3ActiveKeyEpisode>,
    control: &crate::execution_control::V3RequestExecutionControl,
    now_ms: u64,
) -> Result<bool, String> {
    let current = V3TargetInterpreter::candidate_admitted(&selected.candidate, now_ms)
        && match episode.as_deref_mut() {
            Some(episode) => {
                keys.is_some_and(|keys| {
                    selected.active_selection.as_ref() == Some(&episode.selection)
                        && keys.selection_current(&episode.selection)
                }) && episode.begin_attempt().is_some()
            }
            None => selected.active_selection.is_none(),
        };
    if !current {
        control
            .cancel_business_recovery_trial(
                &selected.candidate.provider_id,
                &selected.candidate.interface_id,
                &selected.candidate.auth_alias,
                &selected.candidate.model_id,
            )
            .map_err(|error| error.to_string())?;
        if let Some(episode) = episode {
            episode.cancel();
        }
    }
    Ok(current)
}

/// Selection storage is an internal control diagnostic, never another
/// provider delivery or health observation.
pub(crate) fn active_key_durability_diagnostic(
    selected: &V3Target10ConcreteProviderSelected,
    error: Option<String>,
) -> Option<crate::hub_v1::V3RuntimeProviderFailureObservation> {
    error.map(
        |message| crate::hub_v1::V3RuntimeProviderFailureObservation {
            provider_key: v3_relay_provider_candidate_key(&selected.candidate),
            provider_id: selected.candidate.provider_id.clone(),
            auth_alias: Some(selected.candidate.auth_alias.clone()),
            model_id: selected.candidate.model_id.clone(),
            message,
            internal_code: Some("active_key_hold_persistence_failed".into()),
            action: "active_key_durability_failure".into(),
            ..Default::default()
        },
    )
}

pub(crate) fn select_v3_target_with_session_then_global(
    target: &V3TargetInterpreter,
    mut expanded: V3Target09CandidateSetExpanded,
    failure_session_scope: &V3ProviderFailureSessionScope,
    session_availability: &dyn V3ProviderAvailabilityReader,
    global_availability: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
    active: Option<&V3ActiveKeySelectionContext<'_>>,
) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
    if expanded.route.estimated_history_turns.is_some() {
        expanded.candidates.retain(|candidate| {
            !global_availability
                .provider_blocked_until_compact(failure_session_scope, &candidate.provider_id)
        });
    }
    let reader = V3SessionGlobalSchedulingReader {
        session: session_availability,
        global: global_availability,
        excluded: request_local_excluded_candidates,
    };
    if let Some(active) = active {
        return target.select_available_with_health_active(
            expanded,
            &reader,
            now_ms,
            deterministic_sample,
            active,
        );
    }
    // Sticky selection needs a session that outlives one request. A request
    // without a client session header keeps its existing pool strategy.
    let Some(sticky) = sticky_scope_for(failure_session_scope) else {
        return target.select_available_with_health(
            expanded,
            &reader,
            now_ms,
            deterministic_sample,
        );
    };
    target.select_available_with_health_sticky(
        expanded,
        &reader,
        now_ms,
        deterministic_sample,
        &sticky,
    )
}

fn active_selection_invalidation(
    selection: &routecodex_v3_target::V3ActiveKeySelection,
    candidate: &V3TargetCandidate,
    keys: &routecodex_v3_target::V3ActiveKeySelectionState,
    health: &V3ProviderFailureRuntimeHealth,
    session: &V3ProviderFailureSessionScope,
    now_ms: u64,
) -> Option<V3SelectionInvalidation> {
    let session_reader = health.session_bound_availability(session);
    let excluded = BTreeSet::new();
    let reader = V3SessionGlobalSchedulingReader {
        session: &session_reader,
        global: health,
        excluded: &excluded,
    };
    let available = reader
        .scheduling_projection_for_interface(
            routecodex_v3_provider_responses::V3ProviderKeyRef::new(
                &candidate.provider_id,
                &candidate.auth_alias,
                &candidate.model_id,
            ),
            &candidate.interface_id,
            candidate.priority,
            candidate.weight,
            now_ms,
        )
        .available;
    if !available {
        Some(V3SelectionInvalidation::HealthUnavailable)
    } else if !keys.selection_current(selection) {
        Some(V3SelectionInvalidation::OccurrenceChanged)
    } else {
        None
    }
}

/// Builds the sticky scope for a session that genuinely spans requests.
fn sticky_scope_for(
    failure_session_scope: &V3ProviderFailureSessionScope,
) -> Option<V3StickySelectionScope> {
    if !failure_session_scope.is_client_session() {
        return None;
    }
    Some(V3StickySelectionScope::new(
        failure_session_scope.server_id(),
        failure_session_scope.routing_group(),
        failure_session_scope.session_id(),
    ))
}

struct V3SessionGlobalSchedulingReader<'health> {
    session: &'health dyn V3ProviderAvailabilityReader,
    global: &'health V3ProviderFailureRuntimeHealth,
    excluded: &'health BTreeSet<String>,
}

impl V3ProviderSchedulingReader for V3SessionGlobalSchedulingReader<'_> {
    fn scheduling_projection_for_interface(
        &self,
        key_ref: routecodex_v3_provider_responses::V3ProviderKeyRef<'_>,
        interface_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        let routecodex_v3_provider_responses::V3ProviderKeyRef {
            provider_id,
            auth_alias,
            model_id,
        } = key_ref;
        let mut projection = self.global.scheduling_projection_for_interface(
            routecodex_v3_provider_responses::V3ProviderKeyRef::new(
                provider_id,
                auth_alias,
                model_id,
            ),
            interface_id,
            priority,
            base_weight,
            now_ms,
        );
        let session = self.session.availability_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
            now_ms,
        );
        let excluded_candidate =
            self.excluded
                .contains(&v3_relay_provider_candidate_key_parts_for_interface(
                    provider_id,
                    interface_id,
                    Some(auth_alias),
                    Some(model_id),
                ));
        projection.blocked_scopes.extend(session.blocked_scopes);
        if excluded_candidate {
            projection
                .blocked_scopes
                .push("request_local_provider_failure".to_string());
        }
        projection.available = projection.available && session.available && !excluded_candidate;
        projection
    }

    fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        let mut projection = self.global.scheduling_projection(
            provider_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        );
        let session =
            self.session
                .availability(provider_id, Some(auth_alias), Some(model_id), now_ms);
        // Request-local exclusions are already expanded by the failure policy
        // to the correct candidate or provider-family scope. Keep this reader
        // exact-key so candidate-scoped compatibility failures do not poison
        // sibling models through a second prefix rule.
        let excluded_candidate = self
            .excluded
            .contains(&v3_relay_provider_candidate_key_parts(
                provider_id,
                None,
                Some(auth_alias),
                Some(model_id),
            ));
        projection.blocked_scopes.extend(session.blocked_scopes);
        if excluded_candidate {
            projection
                .blocked_scopes
                .push("request_local_provider_failure".to_string());
        }
        projection.available = projection.available && session.available && !excluded_candidate;
        projection
    }
}

#[derive(Debug, Clone)]
pub struct V3ProviderFailureRuntimeHealth {
    store: V3ProviderHealthStore,
    action_gate: V3ProviderActionGate,
    default_same_provider_retries: usize,
    probe_owner: std::sync::Arc<std::sync::Mutex<Option<V3ManagedProbeSender>>>,
    precool: std::sync::Arc<std::sync::Mutex<BTreeMap<V3PrecoolIdentity, V3DeferredHealthAction>>>,
    observation_clock: Option<Arc<dyn V3ProviderHealthObservationClock>>,
    turn_limits: Arc<std::sync::Mutex<V3ConversationTurnLimits>>,
}

type V3TurnLimitScope = (String, String, String);

#[derive(Debug, Default)]
struct V3ConversationTurnLimits {
    generation: u64,
    blocked: BTreeMap<V3TurnLimitScope, BTreeMap<String, u64>>,
}

impl V3ConversationTurnLimits {
    fn scope_key(scope: &V3ProviderFailureSessionScope) -> V3TurnLimitScope {
        (
            scope.server_id().to_owned(),
            scope.routing_group().to_owned(),
            scope.session_id().to_owned(),
        )
    }
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn provider_blocked_until_compact(
        &self,
        scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
    ) -> bool {
        scope.is_client_session()
            && self
                .turn_limits
                .lock()
                .unwrap()
                .blocked
                .get(&V3ConversationTurnLimits::scope_key(scope))
                .is_some_and(|providers| providers.contains_key(provider_id))
    }

    pub(crate) fn record_session_turn_limit(
        &self,
        scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
    ) {
        if scope.is_client_session() {
            let mut limits = self.turn_limits.lock().unwrap();
            limits.generation += 1;
            let generation = limits.generation;
            limits
                .blocked
                .entry(V3ConversationTurnLimits::scope_key(scope))
                .or_default()
                .insert(provider_id.to_owned(), generation);
        }
    }

    pub(crate) fn compaction_turn_limit_generation(
        &self,
        scope: &V3ProviderFailureSessionScope,
    ) -> Option<u64> {
        scope
            .is_client_session()
            .then(|| self.turn_limits.lock().unwrap().generation)
    }

    pub(crate) fn clear_turn_limits_after_compaction(
        &self,
        scope: &V3ProviderFailureSessionScope,
        through_generation: u64,
        _receipt: &crate::nodes::V3AttemptSuccessReceipt,
    ) {
        let mut limits = self.turn_limits.lock().unwrap();
        let key = V3ConversationTurnLimits::scope_key(scope);
        if let Some(providers) = limits.blocked.get_mut(&key) {
            providers.retain(|_, generation| *generation > through_generation);
            if providers.is_empty() {
                limits.blocked.remove(&key);
            }
        }
    }
}

/// Observation time belongs to the health owner. Request residence and actual
/// transport time remain independent of this injected dependency.
pub trait V3ProviderHealthObservationClock: std::fmt::Debug + Send + Sync {
    fn now_epoch_ms(&self) -> u64;
}

impl V3ProviderFailureRuntimeHealth {
    pub fn with_observation_clock(
        mut self,
        clock: Arc<dyn V3ProviderHealthObservationClock>,
    ) -> Self {
        self.observation_clock = Some(clock);
        self
    }

    pub(crate) fn observation_now_ms(&self, supplied_now_ms: u64) -> u64 {
        self.observation_clock
            .as_ref()
            .map_or(supplied_now_ms, |clock| clock.now_epoch_ms())
    }
}

impl V3ProviderSchedulingReader for V3ProviderFailureRuntimeHealth {
    fn scheduling_projection_for_interface(
        &self,
        key_ref: routecodex_v3_provider_responses::V3ProviderKeyRef<'_>,
        interface_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        let routecodex_v3_provider_responses::V3ProviderKeyRef {
            provider_id,
            auth_alias,
            model_id,
        } = key_ref;
        let now_ms = self.observation_now_ms(now_ms);
        let mut projection = self.store.scheduling_projection_for_interface(
            routecodex_v3_provider_responses::V3ProviderKeyRef::new(
                provider_id,
                auth_alias,
                model_id,
            ),
            interface_id,
            priority,
            base_weight,
            now_ms,
        );
        let availability = V3ProviderAvailabilityReader::availability_for_interface(
            self,
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
            now_ms,
        );
        if !availability.available {
            projection.available = false;
        }
        projection
            .blocked_scopes
            .extend(availability.blocked_scopes);
        projection
    }

    fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        let now_ms = self.observation_now_ms(now_ms);
        let mut projection = V3ProviderSchedulingReader::scheduling_projection(
            &self.store,
            provider_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        );
        let availability = V3ProviderAvailabilityReader::availability(
            self,
            provider_id,
            Some(auth_alias),
            Some(model_id),
            now_ms,
        );
        if !availability.available {
            projection.available = false;
        }
        projection
            .blocked_scopes
            .extend(availability.blocked_scopes);
        projection
    }
}

pub(crate) struct V3SessionGlobalAvailabilityReader {
    session: V3ProviderSessionAvailabilityReader,
    health: V3ProviderFailureRuntimeHealth,
}

impl V3ProviderAvailabilityReader for V3SessionGlobalAvailabilityReader {
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self.session.availability_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            self.health.observation_now_ms(now_ms),
        );
        self.health.apply_precool_availability(
            &mut projection,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        projection
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.availability_for_interface(provider_id, "default", auth_alias, model_id, now_ms)
    }
}

include!("provider_failure_runtime_policy_health.rs");
include!("provider_precool_hold.rs");

impl From<V3ProviderHealthStore> for V3ProviderFailureRuntimeHealth {
    fn from(store: V3ProviderHealthStore) -> Self {
        Self {
            store,
            probe_owner: Default::default(),
            precool: Default::default(),
            observation_clock: None,
            turn_limits: Default::default(),
            action_gate: V3ProviderActionGate::default(),
            default_same_provider_retries: 0,
        }
    }
}

impl V3ProviderAvailabilityReader for V3ProviderFailureRuntimeHealth {
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self.store.availability_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            self.observation_now_ms(now_ms),
        );
        self.apply_precool_availability(
            &mut projection,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        projection
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.availability_for_interface(provider_id, "default", auth_alias, model_id, now_ms)
    }
}

async fn reselect_from_captured_target_plan(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: &V3Target10ConcreteProviderSelected,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
    active_keys: Option<&routecodex_v3_target::V3ActiveKeySelectionState>,
) -> V3RelayProviderSuccessorObservation {
    let expanded = match context.captured_target_09 {
        Some(expanded) => expanded.clone(),
        None => {
            let target = V3TargetInterpreter::default();
            let classified = target.classify_kind(selected.route.clone());
            match target.expand_candidates(
                context.manifest,
                classified,
                context.deterministic_sample,
            ) {
                Ok(expanded) => expanded,
                Err(error) => {
                    return V3RelayProviderSuccessorObservation::Resolution(
                        match target_resolution_source(
                            "V3Target09CandidateSetExpanded",
                            "captured_target_plan_expansion_failed",
                            error,
                        ) {
                            Ok(failure) => V3RelayProviderTargetResolution::Failed(failure),
                            Err(fault) => V3RelayProviderTargetResolution::OperatorFault(fault),
                        },
                    );
                }
            }
        }
    };
    // Error policy observes whether an eligible successor exists. It must not
    // consume an active queue turn or assign a provisional session choice.
    if !expanded.active_pools.is_empty() {
        let observed = observe_v3_target_successors(
            &expanded,
            &context
                .provider_health
                .session_bound_availability(&context.failure_session_scope),
            context.provider_health,
            request_local_excluded_candidates,
            &context.failure_session_scope,
            active_keys,
            now_ms,
        );
        if let Some((occurrence, candidate)) = observed.iter().find_map(|observed| {
            expanded
                .candidates
                .iter()
                .find(|candidate| {
                    observed
                        .identities
                        .contains(&candidate.active_key_identity())
                })
                .map(|candidate| (&observed.occurrence, candidate))
        }) {
            return V3RelayProviderSuccessorObservation::Eligible {
                candidate: candidate.clone(),
                default_pool: occurrence.pool_id == "default",
            };
        }
        return V3RelayProviderSuccessorObservation::Resolution(
            V3RelayProviderTargetResolution::Exhausted {
                attempted_candidates: Vec::new(),
            },
        );
    }
    // This is an observation before Error03's health effects, not a recovery
    // event. It must not start probes or wait on an alternative's recovery.
    V3RelayProviderSuccessorObservation::Resolution(
        match select_v3_target_with_session_then_global(
            &V3TargetInterpreter::default(),
            expanded,
            &context.failure_session_scope,
            &context
                .provider_health
                .session_bound_availability(&context.failure_session_scope),
            context.provider_health,
            request_local_excluded_candidates,
            now_ms,
            context.deterministic_sample,
            None,
        ) {
            Ok(selected) => V3RelayProviderTargetResolution::Selected(selected),
            Err(exhausted) => V3RelayProviderTargetResolution::Exhausted {
                attempted_candidates: exhausted.attempted_candidates,
            },
        },
    )
}

fn v3_relay_provider_policy_ordinary_error(
    error: impl Into<String>,
) -> Result<String, V3RelayErrorOperatorFault> {
    Ok(error.into())
}

pub(crate) async fn run_v3_relay_provider_failure_policy(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    status: u16,
    error_type: Option<String>,
    message: String,
    matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
) -> Result<V3RelayProviderFailurePolicyResult, Result<String, V3RelayErrorOperatorFault>> {
    run_v3_relay_provider_failure_policy_with_response_source(
        context,
        selected,
        source_stage,
        status,
        error_type,
        message,
        matched_policy_directive,
        state,
        None,
        None,
        None,
        None,
    )
    .await
}

pub(crate) async fn run_v3_relay_provider_failure_policy_with_response_source(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    status: u16,
    error_type: Option<String>,
    message: String,
    matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
    response_processing_code: Option<routecodex_v3_error::V3InternalErrorCode>,
    attempt_source: Option<V3Error01SourceRaised>,
    provider_status: Option<u16>,
    provider_body_read_failure: Option<&str>,
) -> Result<V3RelayProviderFailurePolicyResult, Result<String, V3RelayErrorOperatorFault>> {
    run_v3_relay_provider_failure_policy_with_response_source_and_active_keys(
        context,
        selected,
        source_stage,
        status,
        error_type,
        message,
        matched_policy_directive,
        state,
        response_processing_code,
        attempt_source,
        provider_status,
        provider_body_read_failure,
        None,
    )
    .await
}

pub(crate) async fn run_v3_relay_provider_failure_policy_with_response_source_and_active_keys(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    status: u16,
    error_type: Option<String>,
    message: String,
    matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
    response_processing_code: Option<routecodex_v3_error::V3InternalErrorCode>,
    attempt_source: Option<V3Error01SourceRaised>,
    provider_status: Option<u16>,
    provider_body_read_failure: Option<&str>,
    active_keys: Option<&routecodex_v3_target::V3ActiveKeySelectionState>,
) -> Result<V3RelayProviderFailurePolicyResult, Result<String, V3RelayErrorOperatorFault>> {
    let candidate_key = v3_relay_provider_candidate_key(&selected.candidate);
    // The external classification belongs to a real upstream HTTP status: the
    // legacy source code is `provider_http_{status}` and the external link code
    // remains `HTTP_{status}`. Active episodes also retain the actual Provider
    // error category so Error can distinguish quota/auth from ordinary429.
    let is_real_http_failure = provider_status == Some(status);
    let ordinary_request = selected.route.estimated_history_turns.is_some();
    let session_turn_limit_rejected = ordinary_request
        && is_real_http_failure
        && state.last_external_http.as_ref().is_some_and(
            routecodex_v3_error::V3ExternalHttpWitness::is_session_turn_limit_rejection,
        );
    if session_turn_limit_rejected {
        context.provider_health.record_session_turn_limit(
            &context.failure_session_scope,
            &selected.candidate.provider_id,
        );
        if let Some(control) = context.recovery_control {
            control
                .cancel_business_recovery_trial(
                    &selected.candidate.provider_id,
                    &selected.candidate.interface_id,
                    &selected.candidate.auth_alias,
                    &selected.candidate.model_id,
                )
                .map_err(|error| v3_relay_provider_policy_ordinary_error(error.to_string()))?;
        }
    }
    let external_error_type = if is_real_http_failure {
        if active_keys.is_some() && selected.active_selection.is_some() {
            error_type
                .clone()
                .or_else(|| Some(format!("provider_http_{status}")))
        } else {
            Some(format!("provider_http_{status}"))
        }
    } else {
        error_type.clone()
    };
    let external_link_code = is_real_http_failure.then(|| format!("HTTP_{status}"));
    // Permanent request exclusions are recorded only after classification.
    // Recoverable failures remain owned by typed observation/health state.
    // Preserve the original typed Error01 source of this provider attempt before
    // the Error05 decision consumes it, so a later target-resolution failure
    // cannot erase the provider cause that actually began this attempt.
    let (mut attempt_source_projection, mut attempt_source) =
        if let Some(source) = attempt_source {
            serde_json::to_value(&source)
                .map(|projection| (projection, source.clone()))
                .map_err(|error| {
                    relay_error_operator_fault(
                        "relay_error_operator_sdk_failure",
                        format!("failed to serialize V3Error01SourceRaised: {error}"),
                        Some(source),
                    )
                })
        } else if let Some(code) = response_processing_code {
            raise_v3_source_via_err01(
                V3ErrorSourceKind::RuntimeFailure,
                source_stage,
                error_type
                    .as_deref()
                    .unwrap_or("relay_response_processing_failure"),
                &message,
                V3Err01SourceInput::Internal(code),
            )
        } else {
            build_v3_relay_provider_attempt_source(
                &selected,
                source_stage,
                external_error_type.as_deref(),
                &message,
                provider_status,
                external_link_code.as_deref(),
            )
        }
        .map_err(Err)?;
    if active_keys.is_some() && selected.active_selection.is_some() {
        attempt_source =
            routecodex_v3_error::normalize_v3_active_key_failure_source(attempt_source, true);
        attempt_source_projection = serde_json::to_value(&attempt_source).map_err(|error| {
            Err(relay_error_operator_fault(
                "relay_error_operator_sdk_failure",
                error.to_string(),
                Some(attempt_source.clone()),
            ))
        })?;
    }
    let matched_policy = matched_policy_directive.or_else(|| {
        find_matching_provider_error_policy(
            context.manifest,
            context.failure_session_scope.routing_group(),
            &selected.candidate.provider_id,
            Some(&selected.candidate.provider_type),
            Some(&selected.candidate.model_id),
            status,
            error_type.as_deref(),
            &message,
        )
    });
    let reason = (!message.trim().is_empty()).then_some(message.as_str());
    let is_response_processing_failure =
        routecodex_v3_error::is_v3_recoverable_response_processing_source(&attempt_source);
    let is_request_local_compat_failure = session_turn_limit_rejected
        || is_response_processing_failure
        || (!(is_real_http_failure && status == 403)
            && is_health_neutral_request_compat_failure(source_stage, error_type.as_deref()));
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    if session_turn_limit_rejected {
        if let Some(expanded) = context.captured_target_09 {
            excluded_with_failed.extend(
                expanded
                    .candidates
                    .iter()
                    .filter(|candidate| candidate.provider_id == selected.candidate.provider_id)
                    .map(v3_relay_provider_candidate_key),
            );
        }
        state
            .failed_candidates
            .extend(excluded_with_failed.iter().cloned());
    }
    let resolution = reselect_from_captured_target_plan(
        context,
        &selected,
        &excluded_with_failed,
        v3_relay_provider_policy_now_epoch_ms().map_err(v3_relay_provider_policy_ordinary_error)?,
        active_keys,
    )
    .await;
    let has_alternative = matches!(
        &resolution,
        V3RelayProviderSuccessorObservation::Eligible { .. }
            | V3RelayProviderSuccessorObservation::Resolution(
                V3RelayProviderTargetResolution::Selected(_)
            )
    );
    let trial_failed = match context
        .recovery_control
        .filter(|_| !session_turn_limit_rejected)
    {
        Some(control)
            if !matches!(
                attempt_source.source_kind,
                V3ErrorSourceKind::ClientDisconnect
            ) =>
        {
            context
                .provider_health
                .settle_business_recovery_failure(
                    control,
                    &selected.candidate.provider_id,
                    &selected.candidate.interface_id,
                    &selected.candidate.auth_alias,
                    &selected.candidate.model_id,
                    v3_relay_provider_policy_now_epoch_ms()
                        .map_err(v3_relay_provider_policy_ordinary_error)?,
                    has_alternative,
                )
                .map_err(v3_relay_provider_policy_ordinary_error)?
        }
        _ => false,
    };
    if has_alternative
        && !trial_failed
        && !session_turn_limit_rejected
        && is_request_local_compat_failure
        && is_real_http_failure
        && matches!(status, 400..=402 | 404..=599)
    {
        context
            .provider_health
            .store()
            .interrupt_http_403_streak(
                &selected.candidate.provider_id,
                &selected.candidate.interface_id,
                &selected.candidate.auth_alias,
                &selected.candidate.model_id,
            )
            .map_err(v3_relay_provider_policy_ordinary_error)?;
    }
    // Resolve another eligible identity before any health mutation. A terminal
    // attempt publishes diagnostics only; it does not update health or actions.
    // The last or only eligible candidate stays health-neutral for every
    // provider failure class.
    let health_record = if is_request_local_compat_failure || !has_alternative || trial_failed {
        V3ProviderFailureRecord {
            scope_label: candidate_key.clone(),
            provider_key: candidate_key.clone(),
            state: if session_turn_limit_rejected {
                "session_turn_limit_exceeded"
            } else if is_response_processing_failure {
                "request_local_response_processing"
            } else if is_request_local_compat_failure {
                "request_local_provider_compat"
            } else if trial_failed && has_alternative {
                "recovery_trial_failed"
            } else {
                "last_candidate_terminal"
            }
            .to_string(),
            failure_count: 0,
            cooldown_until_ms: None,
            reason: reason.map(str::to_string),
        }
    } else if is_real_http_failure && (400..=599).contains(&status) {
        let health_source = V3Error01SourceRaised {
            code: error_type
                .as_deref()
                .unwrap_or(&attempt_source.code)
                .to_owned(),
            ..attempt_source.clone()
        };
        context
            .provider_health
            .record_provider_failure_record_from_source_for_interface(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                &selected.candidate.interface_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                &health_source,
                v3_relay_provider_policy_now_epoch_ms()
                    .map_err(v3_relay_provider_policy_ordinary_error)?,
            )
            .map_err(v3_relay_provider_policy_ordinary_error)?
    } else {
        context
            .provider_health
            .record_provider_failure_record_with_policy_for_interface(
                matched_policy,
                context.manifest,
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                &selected.candidate.interface_id,
                Some(&selected.candidate.provider_type),
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                reason,
                source_stage,
                status,
                error_type.as_deref(),
                &message,
                v3_relay_provider_policy_now_epoch_ms()
                    .map_err(v3_relay_provider_policy_ordinary_error)?,
            )?
    };
    let resolution = match resolution {
        V3RelayProviderSuccessorObservation::Eligible {
            candidate,
            default_pool,
        } => {
            state.failed_candidates.insert(candidate_key.clone());
            let (projection, decision) = build_v3_relay_provider_error_05_decision(
                &selected,
                attempt_source_projection.clone(),
                attempt_source.clone(),
                usize::from(!default_pool),
                default_pool,
                false,
                None,
                false,
            )
            .map_err(Err)?;
            state.trace.push("V3TargetLocalReselected");
            return Ok(V3RelayProviderFailurePolicyResult {
                business_trial_failed: trial_failed,
                terminal_projection: terminal_projection_for(projection, &decision, matched_policy)
                    .map_err(Err)?,
                terminal_disposition: terminal_disposition_for(
                    &decision,
                    state,
                    provider_body_read_failure,
                ),
                decision,
                // Observation never creates a dispatch target. Plan execution
                // obtains the supplying occurrence and witness from Target.
                retry_selected: None,
                event: build_v3_relay_provider_failure_policy_event(
                    V3RelayProviderFailurePolicyEventInput {
                        candidate: selected.candidate,
                        status,
                        error_type,
                        message,
                        health_record,
                        action: "switch_provider",
                        next_provider_key: Some(v3_relay_provider_candidate_key(&candidate)),
                        wait_ms: None,
                        diagnostic_source: attempt_source,
                    },
                ),
            });
        }
        V3RelayProviderSuccessorObservation::Resolution(resolution) => resolution,
    };
    let route_resolution_proved_no_alternative = match resolution {
        V3RelayProviderTargetResolution::Selected(alternative) => {
            let alternative_key = v3_relay_provider_candidate_key(&alternative.candidate);
            if alternative_key == candidate_key
                || state.failed_candidates.contains(&alternative_key)
            {
                return Err(v3_relay_provider_policy_ordinary_error(format!(
                    "provider failure reselection returned an already failed candidate: {alternative_key}"
                )));
            }
            {
                state.failed_candidates.insert(candidate_key.clone());
                let (decision_projection, decision) = build_v3_relay_provider_error_05_decision(
                    &selected,
                    attempt_source_projection.clone(),
                    attempt_source.clone(),
                    usize::from(!alternative.candidate.default_pool_member),
                    alternative.candidate.default_pool_member,
                    false,
                    None,
                    false,
                )
                .map_err(Err)?;
                state.trace.push("V3TargetLocalReselected");
                return Ok(V3RelayProviderFailurePolicyResult {
                    business_trial_failed: trial_failed,
                    terminal_projection: terminal_projection_for(
                        decision_projection,
                        &decision,
                        matched_policy,
                    )
                    .map_err(Err)?,
                    terminal_disposition: terminal_disposition_for(
                        &decision,
                        state,
                        provider_body_read_failure,
                    ),
                    decision,
                    retry_selected: Some(Box::new(alternative)),
                    event: build_v3_relay_provider_failure_policy_event(
                        V3RelayProviderFailurePolicyEventInput {
                            candidate: selected.candidate,
                            status,
                            error_type: error_type.clone(),
                            message,
                            health_record,
                            action: "switch_provider",
                            next_provider_key: Some(alternative_key),
                            wait_ms: None,
                            diagnostic_source: attempt_source.clone(),
                        },
                    ),
                });
            }
        }
        V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates: _,
        } => true,
        V3RelayProviderTargetResolution::Failed(failure) => {
            let V3RelayProviderTargetResolutionFailure {
                projection: source_projection,
                source,
            } = failure;
            let resolution_message = source.message.clone();
            let original_source = source.clone();
            let (decision_projection, decision) = run_v3_error_02_to_05_decision_operators(
                source_projection,
                source,
                V3ErrorActionScope::None,
                0,
                false,
                false,
                None,
            )
            .map_err(|error| {
                Err(relay_error_operator_fault(
                    "relay_error_operator_sdk_failure",
                    error.message,
                    Some(original_source),
                ))
            })?;
            let terminal_projection =
                terminal_projection_for(decision_projection, &decision, matched_policy)
                    .map_err(Err)?;
            return Ok(V3RelayProviderFailurePolicyResult {
                business_trial_failed: trial_failed,
                terminal_projection,
                terminal_disposition: None,
                decision,
                retry_selected: None,
                event: build_v3_relay_provider_failure_policy_event(
                    V3RelayProviderFailurePolicyEventInput {
                        candidate: selected.candidate,
                        status: 500,
                        error_type: Some("target_resolution_failure".to_string()),
                        message: resolution_message,
                        health_record,
                        action: "project_target_resolution_failure",
                        next_provider_key: None,
                        wait_ms: None,
                        diagnostic_source: attempt_source.clone(),
                    },
                ),
            });
        }
        V3RelayProviderTargetResolution::OperatorFault(fault) => {
            return Err(Err(fault));
        }
    };
    if is_request_local_compat_failure {
        state.failed_candidates.insert(candidate_key);
        let (decision_projection, decision) = build_v3_relay_provider_error_05_decision(
            &selected,
            attempt_source_projection.clone(),
            attempt_source.clone(),
            0,
            false,
            false,
            None,
            false,
        )
        .map_err(Err)?;
        return Ok(V3RelayProviderFailurePolicyResult {
            business_trial_failed: trial_failed,
            terminal_projection: terminal_projection_for(
                decision_projection,
                &decision,
                matched_policy,
            )
            .map_err(Err)?,
            terminal_disposition: terminal_disposition_for(
                &decision,
                state,
                provider_body_read_failure,
            ),
            decision,
            retry_selected: None,
            event: build_v3_relay_provider_failure_policy_event(
                V3RelayProviderFailurePolicyEventInput {
                    candidate: selected.candidate,
                    status,
                    error_type: error_type.clone(),
                    message,
                    health_record,
                    action: "terminal_request_local_provider_compat_exhausted",
                    next_provider_key: None,
                    wait_ms: None,
                    diagnostic_source: attempt_source.clone(),
                },
            ),
        });
    }
    if !route_resolution_proved_no_alternative {
        return Err(v3_relay_provider_policy_ordinary_error(
            "target resolution did not prove route/default exhaustion before terminal Error05"
                .to_string(),
        ));
    }
    state.failed_candidates.insert(candidate_key);
    let (decision_projection, decision) = build_v3_relay_provider_error_05_decision(
        &selected,
        attempt_source_projection,
        attempt_source.clone(),
        0,
        false,
        false,
        None,
        false,
    )
    .map_err(Err)?;
    let terminal_projection =
        terminal_projection_for(decision_projection, &decision, matched_policy).map_err(Err)?;
    let terminal_disposition =
        terminal_disposition_for(&decision, state, provider_body_read_failure);
    Ok(V3RelayProviderFailurePolicyResult {
        business_trial_failed: trial_failed,
        terminal_projection,
        terminal_disposition,
        decision,
        retry_selected: None,
        event: build_v3_relay_provider_failure_policy_event(
            V3RelayProviderFailurePolicyEventInput {
                candidate: selected.candidate,
                status,
                error_type: error_type.clone(),
                message,
                health_record,
                action: "terminal_route_and_default_exhausted",
                next_provider_key: None,
                wait_ms: None,
                diagnostic_source: attempt_source.clone(),
            },
        ),
    })
}

fn terminal_disposition_for(
    decision: &V3Error05ExecutionDecision,
    state: &V3RelayProviderFailurePolicyState<'_>,
    provider_body_read_failure: Option<&str>,
) -> Option<routecodex_v3_error::V3ProviderTerminalDisposition> {
    decision.clone().try_into_terminal().ok().map(|terminal| {
        if terminal
            .execution()
            .exhaustion
            .local_action
            .classified
            .source
            .source_kind
            != V3ErrorSourceKind::ProviderFailure
        {
            return routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse;
        }
        let witness =
            state
                .last_external_http
                .clone()
                .map(|witness| match provider_body_read_failure {
                    Some(reason) => witness.with_body_read_failure(reason),
                    None => witness,
                });
        V3ErrorHandlingCenter::provider_terminal_disposition(terminal, witness)
    })
}

fn terminal_projection_for(
    decision_projection: Value,
    decision: &V3Error05ExecutionDecision,
    matched_policy: Option<&V3ProviderErrorActionPolicyManifest>,
) -> Result<Option<V3Error06ClientProjected>, V3RelayErrorOperatorFault> {
    let Some((_, mut projected)) =
        run_v3_error_06_terminal_projection_operator(decision_projection, decision.clone())
            .map_err(|error| {
                relay_error_operator_fault(
                    "relay_error_operator_sdk_failure",
                    error.message,
                    Some(decision.exhaustion.local_action.classified.source.clone()),
                )
            })?
    else {
        // A failed terminal proof is a legal nonterminal Error05 outcome.
        // It never enters Error06 and never commits a client projection.
        return Ok(None);
    };
    if !is_v3_provider_pool_exhausted(&decision.exhaustion) {
        if let Some(V3ProviderDispositionStepManifest::Project {
            public_code: Some(public_code),
            ..
        }) = matched_policy.and_then(|policy| {
            policy
                .path
                .iter()
                .rev()
                .find(|step| matches!(step, V3ProviderDispositionStepManifest::Project { .. }))
        }) {
            // Error06 owns the terminal HTTP status. Policy projection may only
            // customize the public error code without changing routing truth.
            if let Some(error) = projected
                .body
                .as_object_mut()
                .and_then(|body| body.get_mut("error"))
                .and_then(Value::as_object_mut)
            {
                error.insert("code".to_string(), Value::String(public_code.clone()));
            }
        }
    }
    Ok(Some(projected))
}

pub(crate) fn find_matching_provider_error_policy<'manifest>(
    manifest: &'manifest V3Config05ManifestPublished,
    routing_group: &str,
    provider_id: &str,
    provider_type: Option<&str>,
    model_id: Option<&str>,
    status: u16,
    error_type: Option<&str>,
    message: &str,
) -> Option<&'manifest V3ProviderErrorActionPolicyManifest> {
    manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| {
            provider_error_policy_matches_source_failure(
                policy,
                routing_group,
                provider_id,
                provider_type,
                model_id,
                status,
                error_type,
            ) && (policy.matcher.content_contains_any.is_empty()
                || policy
                    .matcher
                    .content_contains_any
                    .iter()
                    .any(|value| message.contains(value))
                || error_type == Some(policy.action.reason_code.as_str()))
        })
}

pub(crate) fn provider_failure_policy_from_error_policy_directive(
    policy: &V3ProviderErrorActionPolicyManifest,
    status: u16,
    recovery: V3ProviderRecoveryKind,
) -> Result<Option<V3ProviderFailurePolicy>, String> {
    // Error owns recoverable thresholds; internal.toml owns account thresholds; typed class wins over status.
    let internal = routecodex_v3_config::internal::v3_internal_error_handling();
    let failure_threshold = if recovery == V3ProviderRecoveryKind::IrrecoverableGlobalCooldown {
        internal.unrecoverable_failure_threshold
    } else {
        build_v3_provider_global_failure_policy(status)
            .map(|policy| policy.failure_threshold)
            .unwrap_or(routecodex_v3_error::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD)
    };
    let Some(cooldown) = policy.path.iter().find_map(|step| match step {
        V3ProviderDispositionStepManifest::Cooldown {
            scope,
            duration_ms,
            until_restart,
            failure_threshold: step_threshold,
            ..
        } => Some((*scope, *duration_ms, *until_restart, *step_threshold)),
        _ => None,
    }) else {
        return Ok(None);
    };
    let (scope, duration_ms, until_restart, step_threshold) = cooldown;
    let failure_threshold = step_threshold.unwrap_or(failure_threshold);
    if !matches!(
        scope,
        V3ProviderErrorActionScope::AuthKey | V3ProviderErrorActionScope::ProviderModel
    ) {
        // Automatic health cooldown is owned by the exact provider+auth+model
        // key-health path. Administrative provider-instance policies keep their
        // declared scope rather than being silently widened.
        return Ok(None);
    }
    Ok(Some(V3ProviderFailurePolicy {
        failure_threshold,
        cooldown_ms: duration_ms.unwrap_or(1),
        probe_interval_ms: 5_000,
        max_probe_interval_ms: None,
        long_probe_backoff: matches!(status, 401 | 402 | 403 | 503),
        until_restart: until_restart.unwrap_or(false),
        advisory_probe: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    }))
}

fn build_v3_relay_provider_attempt_source(
    selected: &V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    error_type: Option<&str>,
    message: &str,
    provider_status: Option<u16>,
    external_link_code: Option<&str>,
) -> Result<(Value, V3Error01SourceRaised), V3RelayErrorOperatorFault> {
    let code = error_type.unwrap_or("provider_failure").to_string();
    // The numeric policy status also represents synthesized request/transport
    // failures. Only the separately captured HTTP witness proves an upstream
    // status, so Error01 must not claim this policy number as external HTTP.
    raise_v3_source_via_err01(
        V3ErrorSourceKind::ProviderFailure,
        source_stage,
        code.clone(),
        message,
        V3Err01SourceInput::External(V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: provider_status,
            code: Some(
                external_link_code
                    .map(str::to_string)
                    .unwrap_or_else(|| code.clone()),
            ),
            provider_id: Some(selected.candidate.provider_id.clone()),
            upstream_request_id: None,
            message: Some(message.to_string()),
        }),
    )
}

fn build_v3_relay_provider_error_05_decision(
    selected: &V3Target10ConcreteProviderSelected,
    source_projection: Value,
    source: V3Error01SourceRaised,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
    target_recovery_pending: bool,
) -> Result<(Value, V3Error05ExecutionDecision), V3RelayErrorOperatorFault> {
    let original_source = source.clone();
    crate::operation_runner::run_v3_error_02_to_05_decision_operators_with_target_recovery(
        source_projection,
        source,
        V3ErrorActionScope::ProviderKeyModel {
            provider_id: selected.candidate.provider_id.clone(),
            auth_alias: selected.candidate.auth_alias.clone(),
            model_id: selected.candidate.model_id.clone(),
        },
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
        recovery,
        target_recovery_pending,
    )
    .map_err(|error| {
        relay_error_operator_fault(
            "relay_error_operator_sdk_failure",
            error.message,
            Some(original_source),
        )
    })
}

pub(crate) fn expand_v3_relay_target_plan_for_selected(
    manifest: &V3Config05ManifestPublished,
    selected: &V3Target10ConcreteProviderSelected,
    deterministic_sample: u64,
) -> Result<V3Target09CandidateSetExpanded, String> {
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(selected.route.clone());
    target
        .expand_candidates(manifest, kind, deterministic_sample)
        .map_err(|error| error.to_string())
}

/// REQ03 Router owner: classify request facts and hit one opaque route target.
/// Target expands/selects concrete candidates afterward; this helper never reads health.
pub(crate) fn resolve_v3_relay_opaque_target_once(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    entry_kind: &str,
    endpoint_path: &str,
    body: &Value,
    deterministic_sample: u64,
) -> Result<V3Router07OpaqueTargetHitOnce, Result<V3Error01SourceRaised, V3RelayErrorOperatorFault>>
{
    resolve_v3_relay_opaque_target_with_history_images_with_projection(
        manifest,
        server_id,
        entry_kind,
        endpoint_path,
        body,
        deterministic_sample,
        false,
        false,
    )
    .map_err(|error| error.map(|failure| failure.source))
}

pub(crate) fn resolve_v3_relay_opaque_target_with_history_images(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    entry_kind: &str,
    endpoint_path: &str,
    body: &Value,
    deterministic_sample: u64,
    has_unprojected_history_images: bool,
    is_compaction: bool,
) -> Result<
    V3Router07OpaqueTargetHitOnce,
    Result<V3Error01SourceRaised, crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault>,
> {
    resolve_v3_relay_opaque_target_with_history_images_with_projection(
        manifest,
        server_id,
        entry_kind,
        endpoint_path,
        body,
        deterministic_sample,
        has_unprojected_history_images,
        is_compaction,
    )
    .map_err(|error| error.map(|failure| failure.source))
}

fn resolve_v3_relay_opaque_target_with_history_images_with_projection(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    entry_kind: &str,
    endpoint_path: &str,
    body: &Value,
    deterministic_sample: u64,
    has_unprojected_history_images: bool,
    is_compaction: bool,
) -> Result<
    V3Router07OpaqueTargetHitOnce,
    Result<
        V3RelayProviderTargetResolutionFailure,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
> {
    let facts = crate::nodes::build_v3_router_request_facts_for_resolve_target(
        body,
        entry_kind,
        endpoint_path,
        crate::configured_v3_longcontext_threshold_tokens(manifest, server_id),
        is_compaction,
        manifest,
    );
    let router = V3VirtualRouter::process_shared();
    let classified = router
        .classify_request_with_facts(manifest, server_id, endpoint_path, facts)
        .map_err(|error| {
            target_resolution_source(
                "V3Router05RequestClassified",
                "target_resolution_classification_failed",
                error,
            )
        })?;
    let plan = router
        .resolve_route_pool_plan_with_history_images(
            manifest,
            classified,
            has_unprojected_history_images,
        )
        .map_err(|error| {
            target_resolution_source(
                "V3Router06RoutePoolResolved",
                "target_resolution_route_plan_failed",
                error,
            )
        })?;
    router
        .hit_opaque_target_plan_once(plan, deterministic_sample)
        .map_err(|error| {
            target_resolution_source(
                "V3Router07OpaqueTargetHitOnce",
                "target_resolution_opaque_target_failed",
                error,
            )
        })
}

/// REQ04 expands an opaque Router hit through Target; no classification or route re-hit.
/// Health, probes, candidate selection and execution mode remain downstream.
pub(crate) fn expand_v3_relay_target_candidates_from_opaque_hit(
    manifest: &V3Config05ManifestPublished,
    hit: V3Router07OpaqueTargetHitOnce,
    deterministic_sample: u64,
) -> Result<V3Target09CandidateSetExpanded, Result<V3Error01SourceRaised, V3RelayErrorOperatorFault>>
{
    expand_v3_relay_target_candidates_from_opaque_hit_with_projection(
        manifest,
        hit,
        deterministic_sample,
    )
    .map_err(|error| error.map(|failure| failure.source))
}

fn expand_v3_relay_target_candidates_from_opaque_hit_with_projection(
    manifest: &V3Config05ManifestPublished,
    hit: V3Router07OpaqueTargetHitOnce,
    deterministic_sample: u64,
) -> Result<
    V3Target09CandidateSetExpanded,
    Result<
        V3RelayProviderTargetResolutionFailure,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
> {
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    target
        .expand_candidates(manifest, kind, deterministic_sample)
        .map_err(|error| {
            target_resolution_source(
                "V3Target09CandidateSetExpanded",
                "target_resolution_candidate_expansion_failed",
                error,
            )
        })
}

fn build_v3_relay_target_candidates(
    input: &V3RelayProviderTargetResolutionInput<'_>,
) -> Result<V3Target09CandidateSetExpanded, Box<V3RelayProviderTargetResolution>> {
    let hit = resolve_v3_relay_opaque_target_with_history_images_with_projection(
        input.manifest,
        input.server_id,
        input.entry_kind,
        input.endpoint_path,
        input.body,
        input.deterministic_sample,
        false,
        false,
    )
    .map_err(|error| {
        Box::new(match error {
            Ok(failure) => V3RelayProviderTargetResolution::Failed(failure),
            Err(fault) => V3RelayProviderTargetResolution::OperatorFault(fault),
        })
    })?;
    expand_v3_relay_target_candidates_from_opaque_hit_with_projection(
        input.manifest,
        hit,
        input.deterministic_sample,
    )
    .map_err(|error| {
        Box::new(match error {
            Ok(failure) => V3RelayProviderTargetResolution::Failed(failure),
            Err(fault) => V3RelayProviderTargetResolution::OperatorFault(fault),
        })
    })
}

pub(crate) fn resolve_v3_relay_target_outcome(
    input: V3RelayProviderTargetResolutionInput<'_>,
) -> V3RelayProviderTargetResolution {
    let expanded = match build_v3_relay_target_candidates(&input) {
        Ok(expanded) => expanded,
        Err(resolution) => return *resolution,
    };
    let target = V3TargetInterpreter::default();
    let session_availability = input
        .provider_health
        .session_bound_availability(input.failure_session_scope);
    match select_v3_target_with_session_then_global(
        &target,
        expanded.clone(),
        input.failure_session_scope,
        &session_availability,
        input.provider_health,
        input.request_local_excluded_candidates,
        input.now_ms,
        input.deterministic_sample,
        None,
    ) {
        Ok(selected) => V3RelayProviderTargetResolution::Selected(selected),
        Err(exhausted) => V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates: exhausted.attempted_candidates,
        },
    }
}

include!("provider_cooldown_rescue.rs");
include!("provider_probe_lifecycle.rs");

fn target_resolution_source(
    stage: &'static str,
    code: &'static str,
    error: impl std::fmt::Display,
) -> Result<
    V3RelayProviderTargetResolutionFailure,
    crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
> {
    raise_v3_source_via_err01(
        V3ErrorSourceKind::RuntimeFailure,
        stage,
        code,
        error.to_string(),
        V3Err01SourceInput::Plain,
    )
    .map(|(projection, source)| V3RelayProviderTargetResolutionFailure { projection, source })
}

pub(crate) fn v3_relay_provider_target_selection_sample(request_id: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in request_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub(crate) fn v3_relay_provider_candidate_key(candidate: &V3TargetCandidate) -> String {
    v3_relay_provider_candidate_key_parts(
        &candidate.provider_id,
        Some(&candidate.interface_id),
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

pub(crate) fn v3_relay_provider_candidate_key_parts(
    provider_id: &str,
    interface_id: Option<&str>,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    v3_relay_provider_candidate_key_parts_for_interface(
        provider_id,
        interface_id.unwrap_or("default"),
        auth_alias,
        model_id,
    )
}

pub(crate) fn v3_relay_provider_candidate_key_parts_for_interface(
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}:{}",
        provider_id,
        interface_id,
        auth_alias.unwrap_or("-"),
        model_id.unwrap_or("-")
    )
}

include!("provider_failure_runtime_policy_events.rs");

include!("provider_failure_runtime_policy_configured.rs");

/// 瞬态失败（SSE 流内/挂起）同 provider 重试预算：与
/// `V3_TRANSIENT_PROVIDER_RETRY_BUDGET` 一致（=2 次重试，
/// 共 3 次尝试）；第 3 次尝试仍失败才回报一次并切 provider。语义属于
/// provider 内部失败重试，与入口（direct/relay/chat）无关。
#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
#[path = "provider_failure_runtime_policy/req03_opaque_owner_tests.rs"]
mod req03_opaque_owner_tests;

#[cfg(test)]
#[path = "provider_failure_runtime_policy/req04_target_owner_tests.rs"]
mod req04_target_owner_tests;
