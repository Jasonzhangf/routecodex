use futures_util::stream::{FuturesUnordered, StreamExt};
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ProviderDispositionStepManifest,
    V3ProviderErrorActionPolicyManifest, V3ProviderErrorActionScope,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_02_classified_from_v3_error_01,
    build_v3_provider_failure_action_from_v3_error_02,
    build_v3_provider_global_error_fingerprint_from_classified,
    build_v3_provider_global_failure_policy, is_v3_provider_pool_exhausted, V3Error01SourceRaised,
    V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3ProviderFailureSessionScope, V3ProviderHealthScope,
};
use routecodex_v3_provider_responses::{
    adaptive_concurrency::{V3AdaptiveConcurrencyController, V3AdaptiveConcurrencyLease},
    V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader, V3ProviderError,
    V3ProviderFailureAction, V3ProviderFailureCooldownScope, V3ProviderFailurePolicy,
    V3ProviderFailureRecord, V3ProviderHealthStore, V3ProviderKeyHealthProjection,
    V3ProviderRecoveryKind, V3ProviderSchedulingProjection, V3ProviderSchedulingReader,
    V3ProviderSessionAvailabilityReader, V3ResponsesProviderTarget,
};
use routecodex_v3_target::{
    V3Target09CandidateSetExpanded, V3Target10ConcreteProviderSelected, V3TargetCandidate,
    V3TargetExhaustion, V3TargetInterpreter,
};
use routecodex_v3_virtual_router::{V3Router07OpaqueTargetHitOnce, V3VirtualRouter};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::provider_action_gate::{
    V3ProviderActionAdmission, V3ProviderActionFailureRecorded, V3ProviderActionGate,
    V3ProviderActionGateKey, V3ProviderActionProviderScope, V3ProviderActionRecoveryTransition,
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
    Provider(String),
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

/// Error owns typed thresholds: ordinary 429 requires three consecutive failures
/// of the exact provider+interface+auth_alias+model identity; typed classification wins.
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
}

pub(crate) fn project_v3_client_disconnect(
    provider_id: &str,
    source_stage: &'static str,
    message: impl Into<String>,
) -> V3Error06ClientProjected {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ClientDisconnect,
        source_stage,
        "client_disconnect",
        message,
    );
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source,
            action_scope: V3ErrorActionScope::ProviderInstance {
                provider_id: provider_id.to_string(),
            },
            candidates_remaining: 0,
            source_status: Some(499),
        },
        false,
        false,
        None,
    );
    V3ErrorHandlingCenter::project_terminal(decision)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct V3RelayProviderFailureRetryPolicy {
    pub(crate) same_candidate_retries: usize,
}

impl Default for V3RelayProviderFailureRetryPolicy {
    fn default() -> Self {
        Self {
            same_candidate_retries: 0,
        }
    }
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
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3RelayProviderFailurePolicyResult {
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
    Failed(routecodex_v3_error::V3Error01SourceRaised),
}

pub(crate) fn select_v3_target_with_session_then_global(
    target: &V3TargetInterpreter,
    expanded: V3Target09CandidateSetExpanded,
    session_availability: &dyn V3ProviderAvailabilityReader,
    global_availability: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
    deterministic_sample: u64,
) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
    let reader = V3SessionGlobalSchedulingReader {
        session: session_availability,
        global: global_availability,
        excluded: request_local_excluded_candidates,
    };
    target.select_available_with_health(expanded, &reader, now_ms, deterministic_sample)
}

struct V3SessionGlobalSchedulingReader<'health> {
    session: &'health dyn V3ProviderAvailabilityReader,
    global: &'health V3ProviderFailureRuntimeHealth,
    excluded: &'health BTreeSet<String>,
}

impl V3ProviderSchedulingReader for V3SessionGlobalSchedulingReader<'_> {
    fn scheduling_projection_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        let mut projection = self.global.scheduling_projection_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
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
}

impl V3ProviderSchedulingReader for V3ProviderFailureRuntimeHealth {
    fn scheduling_projection_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        let mut projection = self.store.scheduling_projection_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        );
        let availability = self.store.availability_for_interface(
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
        let mut projection = V3ProviderSchedulingReader::scheduling_projection(
            &self.store,
            provider_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        );
        let availability =
            self.store
                .availability(provider_id, Some(auth_alias), Some(model_id), now_ms);
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
        self.session.availability_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
        )
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.session
            .availability(provider_id, auth_alias, model_id, now_ms)
    }
}

include!("provider_failure_runtime_policy_health.rs");

impl From<V3ProviderHealthStore> for V3ProviderFailureRuntimeHealth {
    fn from(store: V3ProviderHealthStore) -> Self {
        Self {
            store,
            probe_owner: Default::default(),
            action_gate: V3ProviderActionGate::process_shared(),
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
        self.store.availability_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
        )
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.store
            .availability(provider_id, auth_alias, model_id, now_ms)
    }
}

async fn reselect_from_captured_target_plan(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: &V3Target10ConcreteProviderSelected,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
) -> V3RelayProviderTargetResolution {
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
                    return V3RelayProviderTargetResolution::Failed(target_resolution_source(
                        "V3Target09CandidateSetExpanded",
                        "captured_target_plan_expansion_failed",
                        error,
                    ));
                }
            }
        }
    };
    match select_v3_expanded_target_with_exhaustion_rescue(
        context.manifest,
        expanded,
        &context.failure_session_scope,
        context.provider_health,
        request_local_excluded_candidates,
        now_ms,
        context.deterministic_sample,
        true,
    )
    .await
    {
        V3TargetSelectionAfterRescue::Selected(selected) => {
            V3RelayProviderTargetResolution::Selected(selected)
        }
        V3TargetSelectionAfterRescue::Exhausted(exhausted) => {
            V3RelayProviderTargetResolution::Exhausted {
                attempted_candidates: exhausted.attempted_candidates,
            }
        }
        V3TargetSelectionAfterRescue::Failed(source) => {
            V3RelayProviderTargetResolution::Failed(source)
        }
    }
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
) -> Result<V3RelayProviderFailurePolicyResult, String> {
    let candidate_key = v3_relay_provider_candidate_key(&selected.candidate);
    // Preserve the original typed Error01 source of this provider attempt before
    // the Error05 decision consumes it, so a later target-resolution failure
    // cannot erase the provider cause that actually began this attempt.
    let attempt_source = build_v3_relay_provider_attempt_source(
        &selected,
        source_stage,
        error_type.as_deref(),
        &message,
    );
    // Request-local provider failure exclusion is monotonic. Record it before
    // health/policy or target-resolution work so every exit path forbids the
    // failed provider:key:model from being sent again.
    state.failed_candidates.insert(candidate_key.clone());
    let matched_policy = matched_policy_directive.or_else(|| {
        find_matching_provider_error_policy(
            context.manifest,
            &selected.candidate.provider_id,
            Some(&selected.candidate.provider_type),
            Some(&selected.candidate.model_id),
            status,
            error_type.as_deref(),
            &message,
        )
    });
    let reason = (!message.trim().is_empty()).then_some(message.as_str());
    let is_request_local_compat_failure =
        is_health_neutral_request_compat_failure(source_stage, error_type.as_deref());
    // SSE/transport failures are provider-health events as well. The
    // failure action builder classifies them as recoverable, so they enter
    // the shared rolling score/cooldown path instead of a synthetic local
    // record.
    let health_record = if is_request_local_compat_failure {
        V3ProviderFailureRecord {
            scope_label: candidate_key.clone(),
            provider_key: candidate_key.clone(),
            state: "request_local_provider_compat".to_string(),
            failure_count: 0,
            cooldown_until_ms: None,
            reason: reason.map(str::to_string),
        }
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
                v3_relay_provider_policy_now_epoch_ms()?,
            )
            .map_err(|error| error.to_string())?
    };
    let retries_done = state
        .same_candidate_retries
        .get(&candidate_key)
        .copied()
        .unwrap_or(0);
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    let resolution = reselect_from_captured_target_plan(
        context,
        &selected,
        &excluded_with_failed,
        v3_relay_provider_policy_now_epoch_ms()?,
    )
    .await;
    let route_resolution_proved_no_alternative = match resolution {
        V3RelayProviderTargetResolution::Selected(alternative) => {
            let alternative_key = v3_relay_provider_candidate_key(&alternative.candidate);
            if alternative_key == candidate_key
                || state.failed_candidates.contains(&alternative_key)
            {
                return Err(format!(
                    "provider failure reselection returned an already failed candidate: {alternative_key}"
                ));
            }
            if !alternative.default_floor_protected {
                let request_local_recovery = || {
                    V3Error05RecoveryAdmissionWitness::new(
                        context.failure_session_scope.clone(),
                        candidate_key.clone(),
                        error_type
                            .as_deref()
                            .unwrap_or("provider_request_compat_error"),
                        1,
                    )
                };
                let recovery = if is_request_local_compat_failure {
                    None
                } else {
                    let configured_backoff_ms =
                        configured_retry_backoff_ms(matched_policy, retries_done);
                    Some(if configured_backoff_ms == 0 {
                        context
                            .provider_health
                            .record_provider_action_failure_in_scope_for_interface(
                                &context.failure_session_scope,
                                &selected.candidate.provider_id,
                                &selected.candidate.interface_id,
                                Some(&selected.candidate.auth_alias),
                                Some(&selected.candidate.model_id),
                                error_type.as_deref().unwrap_or("provider_failure"),
                            )?
                    } else {
                        context
                            .provider_health
                            .record_provider_action_failure_in_scope_with_minimum_delay_for_interface(
                                &context.failure_session_scope,
                                &selected.candidate.provider_id,
                                &selected.candidate.interface_id,
                                Some(&selected.candidate.auth_alias),
                                Some(&selected.candidate.model_id),
                                error_type.as_deref().unwrap_or("provider_failure"),
                                configured_backoff_ms,
                            )?
                    })
                };
                let decision = build_v3_relay_provider_error_05_decision(
                    &selected,
                    attempt_source.clone(),
                    status,
                    usize::from(!alternative.candidate.default_pool_member),
                    alternative.candidate.default_pool_member,
                    false,
                    if let Some(record) = recovery.as_ref() {
                        Some(record.recovery_witness()?)
                    } else {
                        Some(request_local_recovery()?)
                    },
                );
                state.failed_candidates.insert(candidate_key);
                state.trace.push("V3TargetLocalReselected");
                return Ok(V3RelayProviderFailurePolicyResult {
                    terminal_projection: terminal_projection_for(&decision, matched_policy),
                    terminal_disposition: terminal_disposition_for(&decision, state),
                    decision,
                    retry_selected: Some(Box::new(alternative)),
                    event: build_v3_relay_provider_failure_policy_event(
                        V3RelayProviderFailurePolicyEventInput {
                            candidate: selected.candidate,
                            status,
                            error_type,
                            message,
                            health_record,
                            action: "switch_provider",
                            next_provider_key: Some(alternative_key),
                            wait_ms: recovery.as_ref().map(|record| record.minimum_delay_ms),
                            diagnostic_source: attempt_source.clone(),
                        },
                    ),
                });
            }
            true
        }
        V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates: _,
        } => true,
        V3RelayProviderTargetResolution::Failed(source) => {
            let resolution_message = source.message.clone();
            let decision = V3ErrorHandlingCenter::decide_provider(
                V3ErrorHandlingCenterInput {
                    source,
                    action_scope: V3ErrorActionScope::None,
                    candidates_remaining: 0,
                    source_status: Some(500),
                },
                false,
                false,
                None,
            );
            return Ok(V3RelayProviderFailurePolicyResult {
                terminal_projection: terminal_projection_for(&decision, matched_policy),
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
    };
    if is_request_local_compat_failure {
        state.failed_candidates.insert(candidate_key);
        let decision = build_v3_relay_provider_error_05_decision(
            &selected,
            attempt_source.clone(),
            status,
            0,
            false,
            false,
            None,
        );
        return Ok(V3RelayProviderFailurePolicyResult {
            terminal_projection: terminal_projection_for(&decision, matched_policy),
            terminal_disposition: terminal_disposition_for(&decision, state),
            decision,
            retry_selected: None,
            event: build_v3_relay_provider_failure_policy_event(
                V3RelayProviderFailurePolicyEventInput {
                    candidate: selected.candidate,
                    status,
                    error_type,
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
        return Err(
            "target resolution did not prove route/default exhaustion before terminal Error05"
                .to_string(),
        );
    }
    state.failed_candidates.insert(candidate_key);
    let decision = build_v3_relay_provider_error_05_decision(
        &selected,
        attempt_source.clone(),
        status,
        0,
        false,
        false,
        None,
    );
    let admission = context
        .provider_health
        .record_terminal_provider_projection_in_scope_for_interface(
            &context.failure_session_scope,
            &selected.candidate.provider_id,
            &selected.candidate.interface_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            error_type.as_deref().unwrap_or("provider_failure"),
        )?;
    Ok(V3RelayProviderFailurePolicyResult {
        terminal_projection: terminal_projection_for(&decision, matched_policy),
        terminal_disposition: terminal_disposition_for(&decision, state),
        decision,
        retry_selected: None,
        event: build_v3_relay_provider_failure_policy_event(
            V3RelayProviderFailurePolicyEventInput {
                candidate: selected.candidate,
                status,
                error_type,
                message,
                health_record,
                action: "terminal_route_and_default_exhausted",
                next_provider_key: None,
                wait_ms: Some(admission.minimum_delay_ms),
                diagnostic_source: attempt_source.clone(),
            },
        ),
    })
}

fn terminal_disposition_for(
    decision: &V3Error05ExecutionDecision,
    state: &V3RelayProviderFailurePolicyState<'_>,
) -> Option<routecodex_v3_error::V3ProviderTerminalDisposition> {
    decision.clone().try_into_terminal().ok().map(|terminal| {
        V3ErrorHandlingCenter::provider_terminal_disposition(
            terminal,
            state.last_external_http.clone(),
        )
    })
}

fn terminal_projection_for(
    decision: &V3Error05ExecutionDecision,
    matched_policy: Option<&V3ProviderErrorActionPolicyManifest>,
) -> Option<V3Error06ClientProjected> {
    // 非 terminal decision 携带 None 是合法 Option 状态（调用点仅在
    // ProjectTerminal 时消费，并以 expect 锁定不变量）；不允许静默吞错。
    let mut projected = decision
        .clone()
        .try_into_terminal()
        .ok()
        .map(V3ErrorHandlingCenter::project_terminal_decision)?;
    if !is_v3_provider_pool_exhausted(&decision.exhaustion) {
        if let Some(V3ProviderDispositionStepManifest::Project { public_code, .. }) = matched_policy
            .and_then(|policy| {
                policy.path.iter().rev().find_map(|step| match step {
                    V3ProviderDispositionStepManifest::Project { .. } => Some(step),
                    _ => None,
                })
            })
        {
            // Error06 owns the terminal HTTP status. Policy projection may only
            // customize the public error code without changing routing truth.
            if let Some(public_code) = public_code {
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
    }
    Some(projected)
}

fn find_matching_provider_error_policy<'manifest>(
    manifest: &'manifest V3Config05ManifestPublished,
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

fn provider_failure_policy_from_error_policy_directive(
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
            ..
        } => Some((*scope, *duration_ms, *until_restart)),
        _ => None,
    }) else {
        return Ok(None);
    };
    let (scope, duration_ms, until_restart) = cooldown;
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
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    }))
}

fn build_v3_relay_provider_attempt_source(
    selected: &V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    error_type: Option<&str>,
    message: &str,
) -> V3Error01SourceRaised {
    let code = error_type.unwrap_or("provider_failure").to_string();
    // The numeric policy status also represents synthesized request/transport
    // failures. Only the separately captured HTTP witness proves an upstream
    // status, so Error01 must not claim this policy number as external HTTP.
    build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        source_stage,
        code.clone(),
        message,
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some(code),
            provider_id: Some(selected.candidate.provider_id.clone()),
            upstream_request_id: None,
            message: Some(message.to_string()),
        },
    )
}

fn build_v3_relay_provider_error_05_decision(
    selected: &V3Target10ConcreteProviderSelected,
    source: V3Error01SourceRaised,
    status: u16,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> V3Error05ExecutionDecision {
    V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source,
            action_scope: V3ErrorActionScope::ProviderKeyModel {
                provider_id: selected.candidate.provider_id.clone(),
                auth_alias: selected.candidate.auth_alias.clone(),
                model_id: selected.candidate.model_id.clone(),
            },
            candidates_remaining: route_pool_remaining_after_exclusion,
            source_status: Some(status),
        },
        default_pool_available,
        same_provider_retry_available,
        recovery,
    )
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
) -> Result<V3Router07OpaqueTargetHitOnce, V3Error01SourceRaised> {
    let facts = crate::build_v3_router_request_facts_for_entry_with_manifest(
        body,
        entry_kind,
        crate::configured_v3_longcontext_threshold_tokens(manifest, server_id),
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
        .resolve_route_pool_plan(manifest, classified)
        .map_err(|error| {
            crate::shared::v3_route_plan_error_source(
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
) -> Result<V3Target09CandidateSetExpanded, V3Error01SourceRaised> {
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
) -> Result<V3Target09CandidateSetExpanded, V3RelayProviderTargetResolution> {
    let hit = resolve_v3_relay_opaque_target_once(
        input.manifest,
        input.server_id,
        input.entry_kind,
        input.endpoint_path,
        input.body,
        input.deterministic_sample,
    )
    .map_err(V3RelayProviderTargetResolution::Failed)?;
    expand_v3_relay_target_candidates_from_opaque_hit(
        input.manifest,
        hit,
        input.deterministic_sample,
    )
    .map_err(V3RelayProviderTargetResolution::Failed)
}

pub(crate) fn resolve_v3_relay_target_outcome(
    input: V3RelayProviderTargetResolutionInput<'_>,
) -> V3RelayProviderTargetResolution {
    let expanded = match build_v3_relay_target_candidates(&input) {
        Ok(expanded) => expanded,
        Err(resolution) => return resolution,
    };
    let target = V3TargetInterpreter::default();
    let session_availability = input
        .provider_health
        .session_bound_availability(input.failure_session_scope);
    match select_v3_target_with_session_then_global(
        &target,
        expanded.clone(),
        &session_availability,
        input.provider_health,
        input.request_local_excluded_candidates,
        input.now_ms,
        input.deterministic_sample,
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
) -> routecodex_v3_error::V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        stage,
        code,
        error.to_string(),
    )
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
mod tests;

#[cfg(test)]
#[path = "provider_failure_runtime_policy/req03_opaque_owner_tests.rs"]
mod req03_opaque_owner_tests;

#[cfg(test)]
#[path = "provider_failure_runtime_policy/req04_target_owner_tests.rs"]
mod req04_target_owner_tests;
