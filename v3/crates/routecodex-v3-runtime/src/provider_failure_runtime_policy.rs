use futures_util::stream::{FuturesUnordered, StreamExt};
use routecodex_v3_config::internal::{
    classify_v3_internal_provider_error, v3_internal_error_handling,
};
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ProviderDispositionStepManifest,
    V3ProviderErrorActionPolicyManifest, V3ProviderErrorActionScope, V3ProviderErrorRetryMode,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_02_classified_from_v3_error_01,
    build_v3_provider_failure_action_from_v3_error_02, build_v3_provider_global_failure_policy,
    is_v3_provider_pool_exhausted, V3Error01SourceRaised, V3Error02Classified,
    V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3ProviderFailureSessionScope, V3ProviderHealthScope,
};
use routecodex_v3_provider_responses::{
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
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::provider_action_gate::{
    V3ProviderActionAdmission, V3ProviderActionFailureRecorded, V3ProviderActionGate,
    V3ProviderActionGateKey, V3ProviderActionProviderScope, V3ProviderActionRecoveryTransition,
};
use crate::provider_error_policy_matching::provider_error_policy_matches_source_failure;
pub use crate::provider_failure_global_probe::build_v3_provider_global_probe_target;
pub(crate) use crate::provider_failure_global_probe::probe_v3_provider_global_target_impl;

struct V3ProviderProbeCancellationGuard {
    store: V3ProviderHealthStore,
    provider_id: String,
    auth_alias: Option<String>,
    model_id: Option<String>,
    expected_generation: u64,
}

const V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY: usize = 4;

#[derive(Debug)]
pub enum V3ProviderHealthProbeFailure {
    Provider(String),
    Internal(String),
}

async fn execute_provider_health_probe<F, Fut>(
    store: V3ProviderHealthStore,
    permit: routecodex_v3_provider_responses::V3ProviderHealthProbePermit,
    probe: F,
) -> (
    V3ProviderProbeCancellationGuard,
    String,
    Option<String>,
    Option<String>,
    u64,
    Result<(), V3ProviderHealthProbeFailure>,
)
where
    F: Fn(String, Option<String>, Option<String>) -> Fut,
    Fut: Future<Output = Result<(), V3ProviderHealthProbeFailure>>,
{
    let provider_id = permit.provider_id().to_string();
    let auth_alias = permit.auth_alias().map(str::to_string);
    let model_id = permit.model_id().map(str::to_string);
    let expected_generation = permit.expected_generation();
    let cancellation = V3ProviderProbeCancellationGuard {
        store,
        provider_id: provider_id.clone(),
        auth_alias: auth_alias.clone(),
        model_id: model_id.clone(),
        expected_generation,
    };
    let result = probe(provider_id.clone(), auth_alias.clone(), model_id.clone()).await;
    (
        cancellation,
        provider_id,
        auth_alias,
        model_id,
        expected_generation,
        result,
    )
}

impl Drop for V3ProviderProbeCancellationGuard {
    fn drop(&mut self) {
        let _ = self.store.cancel_provider_cooldown_probe_at_generation(
            &self.provider_id,
            self.auth_alias.as_deref(),
            self.model_id.as_deref(),
            self.expected_generation,
        );
    }
}

pub async fn probe_v3_provider_global_target(
    target: V3ResponsesProviderTarget,
) -> Result<(), V3ProviderHealthProbeFailure> {
    probe_v3_provider_global_target_impl(target).await
}

/// internal.toml 全局错误策略表的落地点：401/403/503 → 连续 2 次×1h；402 → 连续 3 次×1h；
/// 429/其余 5xx → 连续 3 次×15m；其余 provider 失败沿用 typed 分类结果并按默认
/// recoverable 阈值（3）计数。任何失败连续达到阈值即进入全局冷却，
/// 由后台探活（先密后稀阶梯）或真实成功恢复。
pub(crate) fn apply_v3_internal_provider_failure_policy(
    mut action: V3ProviderFailureAction,
    source_stage: &str,
    status: u16,
    code: &str,
) -> V3ProviderFailureAction {
    let _ = (source_stage, code);
    if let Some(policy) = build_v3_provider_global_failure_policy(status) {
        action.failure_threshold = policy.failure_threshold;
        action.cooldown_ms = policy.cooldown_ms;
        action.long_probe_backoff = matches!(status, 401 | 402 | 403 | 503);
        action.scope = V3ProviderHealthScope::GlobalProviderKey;
        return action;
    }
    if action.failure_threshold == 0 {
        action.failure_threshold = match action.recovery {
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown => 2,
            V3ProviderRecoveryKind::RecoverableCounted => 3,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3RequestLocalProviderFailureScope {
    Candidate,
    Provider,
}

pub(crate) fn request_local_provider_failure_scope(
    source_stage: &str,
    error_type: Option<&str>,
) -> V3RequestLocalProviderFailureScope {
    let request_local_compat = source_stage == "ProviderReqCompat06ProviderCompat"
        || error_type == Some("provider_request_compat_error");
    if request_local_compat {
        V3RequestLocalProviderFailureScope::Candidate
    } else {
        V3RequestLocalProviderFailureScope::Provider
    }
}

pub(crate) fn expand_request_local_provider_failure_scope(
    scope: V3RequestLocalProviderFailureScope,
    selected: &V3Target10ConcreteProviderSelected,
    expanded: &V3Target09CandidateSetExpanded,
) -> BTreeSet<String> {
    let mut failed = BTreeSet::from([v3_relay_provider_candidate_key(&selected.candidate)]);
    if scope == V3RequestLocalProviderFailureScope::Provider {
        failed.extend(
            expanded
                .candidates
                .iter()
                .filter(|candidate| candidate.provider_id == selected.candidate.provider_id)
                .map(v3_relay_provider_candidate_key),
        );
    }
    failed
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
    pub(crate) error_type: Option<String>,
    pub(crate) message: String,
    pub(crate) health_record: V3ProviderFailureRecord,
    pub(crate) action: String,
    pub(crate) next_provider_key: Option<String>,
    pub(crate) wait_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3RelayProviderFailurePolicyResult {
    pub(crate) decision: V3Error05ExecutionDecision,
    pub(crate) retry_selected: Option<Box<V3Target10ConcreteProviderSelected>>,
    pub(crate) terminal_projection: Option<V3Error06ClientProjected>,
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
}

impl V3ProviderSchedulingReader for V3ProviderFailureRuntimeHealth {
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

impl V3ProviderFailureRuntimeHealth {
    pub fn from_manifest_for_tests(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest_without_persistence(manifest);
        Self {
            store,
            action_gate: V3ProviderActionGate::process_shared(),
            default_same_provider_retries: V3RelayProviderFailureRetryPolicy::from_manifest(
                manifest,
            )
            .same_candidate_retries,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self::from_manifest_for_tests(manifest)
    }

    #[cfg(not(test))]
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        let store = V3ProviderHealthStore::from_manifest(manifest);
        Self {
            store,
            action_gate: V3ProviderActionGate::process_shared(),
            default_same_provider_retries: V3RelayProviderFailureRetryPolicy::from_manifest(
                manifest,
            )
            .same_candidate_retries,
        }
    }

    pub(crate) fn record_provider_key_failure_action(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<Option<V3ProviderKeyHealthProjection>, String> {
        let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) else {
            if action.recovery != V3ProviderRecoveryKind::NotProviderHealth {
                return Err(format!(
                    "provider health action {} requires complete key identity: provider={provider_id} auth_alias={auth_alias:?} model_id={model_id:?}",
                    action.class_code
                ));
            }
            return Ok(None);
        };
        self.store
            .record_provider_failure_action(provider_id, auth_alias, model_id, action, now_ms)
            .map(Some)
    }

    pub async fn run_due_provider_health_probes<F, Fut>(
        &self,
        now_ms: u64,
        startup: bool,
        probe: F,
    ) -> Result<(), String>
    where
        F: Fn(String, Option<String>, Option<String>) -> Fut + Clone,
        Fut: Future<Output = Result<(), V3ProviderHealthProbeFailure>>,
    {
        let mut probe_errors = Vec::new();
        let mut pending_keys = self
            .store
            .provider_cooldown_probe_keys(now_ms, startup)
            .map_err(|error| error.to_string())?
            .into_iter();
        let mut in_flight = FuturesUnordered::new();
        while in_flight.len() < V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY {
            let Some((provider_id, auth_alias, model_id)) = pending_keys.next() else {
                break;
            };
            let permit = match self.store.acquire_provider_cooldown_probe(
                &provider_id,
                auth_alias.as_deref(),
                model_id.as_deref(),
            ) {
                Ok(Some(permit)) => permit,
                Ok(None) => continue,
                Err(error) => {
                    probe_errors.push(error.to_string());
                    break;
                }
            };
            in_flight.push(execute_provider_health_probe(
                self.store.clone(),
                permit,
                probe.clone(),
            ));
        }
        while let Some((
            cancellation,
            provider_id,
            auth_alias,
            model_id,
            expected_generation,
            result,
        )) = in_flight.next().await
        {
            let completion_now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(duration) => duration.as_millis() as u64,
                Err(error) => {
                    probe_errors.push(format!("provider probe completion clock failure: {error}"));
                    now_ms
                }
            };
            match result {
                Ok(()) => {
                    if let Err(error) = self
                        .store
                        .complete_provider_cooldown_probe_success_at_generation(
                            &provider_id,
                            auth_alias.as_deref(),
                            model_id.as_deref(),
                            completion_now_ms,
                            Some(expected_generation),
                        )
                    {
                        probe_errors.push(error.to_string());
                    }
                }
                Err(V3ProviderHealthProbeFailure::Provider(error)) => {
                    if let Err(completion_error) = self
                        .store
                        .complete_provider_cooldown_probe_failure_at_generation(
                            &provider_id,
                            auth_alias.as_deref(),
                            model_id.as_deref(),
                            completion_now_ms,
                            Some(expected_generation),
                        )
                    {
                        probe_errors.push(completion_error.to_string());
                    }
                    eprintln!(
                        "provider health probe failed: provider={provider_id} auth_alias={auth_alias:?} model={model_id:?} error={error}"
                    );
                }
                Err(V3ProviderHealthProbeFailure::Internal(error)) => {
                    if let Err(completion_error) = self
                        .store
                        .complete_provider_cooldown_probe_failure_at_generation(
                            &provider_id,
                            auth_alias.as_deref(),
                            model_id.as_deref(),
                            completion_now_ms,
                            Some(expected_generation),
                        )
                    {
                        probe_errors.push(completion_error.to_string());
                    }
                    probe_errors.push(error);
                }
            }
            drop(cancellation);
            while in_flight.len() < V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY {
                let Some((provider_id, auth_alias, model_id)) = pending_keys.next() else {
                    break;
                };
                let permit = match self.store.acquire_provider_cooldown_probe(
                    &provider_id,
                    auth_alias.as_deref(),
                    model_id.as_deref(),
                ) {
                    Ok(Some(permit)) => permit,
                    Ok(None) => continue,
                    Err(error) => {
                        probe_errors.push(error.to_string());
                        break;
                    }
                };
                in_flight.push(execute_provider_health_probe(
                    self.store.clone(),
                    permit,
                    probe.clone(),
                ));
            }
        }
        if probe_errors.is_empty() {
            Ok(())
        } else {
            Err(probe_errors.join("; "))
        }
    }

    pub(crate) fn default_same_provider_retries(&self) -> usize {
        self.default_same_provider_retries
    }

    pub(crate) fn record_provider_failure_record(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.store
            .record_provider_failure_in_session(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                reason,
                now_ms,
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_failure_record_from_source(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        source: &V3Error01SourceRaised,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        let _classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
        self.store
            .record_provider_failure_in_session(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                Some(&source.message),
                now_ms,
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_failure_record_with_action(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
        action: &V3ProviderFailureAction,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.record_provider_key_failure_action(provider_id, auth_alias, model_id, action, now_ms)?;
        self.record_provider_failure_in_session_without_health_cooldown(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            reason,
            now_ms,
        )
    }

    pub(crate) fn record_provider_failure_in_session_without_health_cooldown(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.store
            .record_provider_failure_in_session_with_policy(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                reason,
                now_ms,
                Some(V3ProviderFailurePolicy {
                    failure_threshold: u32::MAX,
                    cooldown_ms: 1,
                    probe_interval_ms: 1,
                    max_probe_interval_ms: None,
                    long_probe_backoff: false,
                    until_restart: false,
                    cooldown_scope: V3ProviderFailureCooldownScope::Session,
                }),
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_failure_record_with_policy(
        &self,
        matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
        _manifest: &V3Config05ManifestPublished,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        _provider_type: Option<&str>,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        source_stage: &'static str,
        status: u16,
        error_type: Option<&str>,
        message: &str,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        let code = error_type.unwrap_or("provider_failure").to_string();
        let source = build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            source_stage,
            code.clone(),
            message,
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some(code),
                provider_id: Some(provider_id.to_string()),
                upstream_request_id: None,
                message: Some(message.to_string()),
            },
        );
        let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
        if let Some(policy) = matched_policy_directive
            .map(|policy| provider_failure_policy_from_error_policy_directive(policy, status))
            .transpose()?
            .flatten()
        {
            return self
                .store
                .record_provider_failure_in_session_with_policy(
                    failure_session_scope,
                    provider_id,
                    auth_alias,
                    model_id,
                    reason,
                    now_ms,
                    Some(policy),
                )
                .map_err(|error| error.to_string());
        }
        // 统一错误模型：任何 provider 失败（含 400/invalid_request）都按
        // internal 全局策略表盖章阈值后计入全局健康；连续达到阈值即进入
        // 全局冷却，由后台探活或真实成功恢复，不再按状态码豁免。
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(&classified),
            source_stage,
            status,
            error_type.unwrap_or("provider_failure"),
        );
        let projection = self.record_provider_key_failure_action(
            provider_id,
            auth_alias,
            model_id,
            &action,
            now_ms,
        )?;
        let session_record = self.record_provider_failure_in_session_without_health_cooldown(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            reason,
            now_ms,
        )?;
        let Some(projection) = projection else {
            return Ok(session_record);
        };
        let provider_key = v3_relay_provider_candidate_key_parts(
            &projection.provider_id,
            Some(&projection.auth_alias),
            Some(&projection.model_id),
        );
        Ok(V3ProviderFailureRecord {
            scope_label: session_record.scope_label,
            provider_key,
            state: if projection.cooldown {
                "cooldown".to_string()
            } else {
                "healthy".to_string()
            },
            failure_count: projection.failure_streak,
            cooldown_until_ms: projection.cooldown_until_ms,
            reason: session_record.reason,
        })
    }

    pub(crate) fn record_provider_success_in_failure_scope(
        &self,
        _receipt: &crate::nodes::V3AttemptSuccessReceipt,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        self.store
            .record_provider_success_in_session(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                now_ms,
            )
            .map_err(|error| error.to_string())?;
        if let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) {
            self.store
                .record_provider_key_success(provider_id, auth_alias, model_id, now_ms)?;
        }
        self.action_gate
            .record_provider_success(&V3ProviderActionProviderScope::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
            )?)
    }

    /// 瞬态失败（SSE 流内/挂起）耗尽 3 次尝试后的 session 级短期绕行：
    /// health-neutral（不触发 15 分钟 cooldown、不累计失败数），但同 session
    /// 后续请求短时绕开该 provider，避免反复命中；超时自动恢复。
    pub(crate) fn record_provider_transient_bypass_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.store
            .record_provider_transient_bypass_in_session(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                reason,
                now_ms,
            )
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_action_failure_in_scope(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.record_provider_action_failure_in_scope_with_minimum_delay(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            error_family,
            0,
        )
    }

    pub(crate) fn record_provider_action_failure_in_scope_with_minimum_delay(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
        minimum_delay_ms: u64,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.action_gate.record_failure_with_minimum_delay(
            &V3ProviderActionGateKey::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
                error_family,
            )?,
            minimum_delay_ms,
        )
    }

    pub(crate) async fn wait_for_terminal_provider_projection_in_scope(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionAdmission, String> {
        self.action_gate
            .record_failure_and_wait(V3ProviderActionGateKey::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
                error_family,
            )?)
            .await
    }

    pub(crate) async fn wait_for_provider_action_failure_in_scope(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionAdmission, String> {
        self.action_gate
            .record_failure_and_wait(V3ProviderActionGateKey::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
                error_family,
            )?)
            .await
    }

    pub(crate) fn record_post_commit_provider_stream_failure(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _error_family: &str,
        reason: &str,
    ) -> Result<(), String> {
        // Post-commit SSE failures are provider-health events. They share the
        // same recoverable score/cooldown policy as pre-commit SSE failures.
        // 统一错误模型：无状态码上下文时按默认 recoverable 阈值（3）盖章。
        let action = apply_v3_internal_provider_failure_policy(
            V3ProviderFailureAction::recoverable(_error_family),
            "",
            0,
            _error_family,
        );
        self.record_provider_failure_record_with_action(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            Some(reason),
            v3_relay_provider_policy_now_epoch_ms()?,
            &action,
        )?;
        self.record_provider_action_failure_in_scope(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            _error_family,
        )?;
        Ok(())
    }

    pub(crate) fn record_post_commit_provider_stream_failure_from_source(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        source: &V3Error01SourceRaised,
    ) -> Result<(), String> {
        let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
        // 统一错误模型：post-commit 流失败同样经 internal 全局策略表盖章。
        // 旧瞬态分类（HealthNeutralTransient/NotProviderHealth）显式转换为
        // recoverable counted，不允许 health-neutral 旁路绕过冷却/探活。
        let status = source
            .external_error
            .as_ref()
            .and_then(|error| error.status)
            .unwrap_or(0);
        let mut action = build_v3_provider_failure_action_from_v3_error_02(&classified);
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::HealthNeutralTransient
                | V3ProviderRecoveryKind::NotProviderHealth
        ) {
            action = V3ProviderFailureAction::recoverable(&source.code);
        }
        let action = apply_v3_internal_provider_failure_policy(
            action,
            source.source_stage,
            status,
            &source.code,
        );
        let now_ms = v3_relay_provider_policy_now_epoch_ms()?;
        self.record_provider_failure_record_with_action(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            Some(&source.message),
            now_ms,
            &action,
        )?;
        self.record_provider_action_failure_in_scope(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            &source.code,
        )?;
        Ok(())
    }

    pub(crate) async fn wait_for_error05_recovery(
        &self,
        witness: &V3Error05RecoveryAdmissionWitness,
        selected: &V3Target10ConcreteProviderSelected,
    ) -> Result<V3ProviderActionRecoveryTransition, String> {
        let provider_scope = V3ProviderActionProviderScope::new(
            witness.failure_session_scope(),
            v3_relay_provider_candidate_key_parts(
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
            ),
        )?;
        self.action_gate
            .wait_for_recovery_witness(witness, provider_scope)
            .await
    }

    pub(crate) async fn wait_for_exact_selected_provider_action(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        selected: &V3Target10ConcreteProviderSelected,
    ) -> Result<Option<V3ProviderActionAdmission>, String> {
        self.action_gate
            .wait_for_exact_provider_action(&V3ProviderActionProviderScope::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                ),
            )?)
            .await
    }

    pub(crate) fn store(&self) -> V3ProviderHealthStore {
        self.store.clone()
    }

    pub(crate) fn session_bound_availability(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
    ) -> V3SessionGlobalAvailabilityReader {
        V3SessionGlobalAvailabilityReader {
            session: V3ProviderSessionAvailabilityReader::new(
                self.store.clone(),
                failure_session_scope.clone(),
            ),
        }
    }
}

impl From<V3ProviderHealthStore> for V3ProviderFailureRuntimeHealth {
    fn from(store: V3ProviderHealthStore) -> Self {
        Self {
            store,
            action_gate: V3ProviderActionGate::process_shared(),
            default_same_provider_retries: 0,
        }
    }
}

impl V3ProviderAvailabilityReader for V3ProviderFailureRuntimeHealth {
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
    let request_local_scope =
        request_local_provider_failure_scope(source_stage, error_type.as_deref());
    let is_request_local_compat_failure =
        request_local_scope == V3RequestLocalProviderFailureScope::Candidate;
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
            .record_provider_failure_record_with_policy(
                matched_policy,
                context.manifest,
                &context.failure_session_scope,
                &selected.candidate.provider_id,
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
    let provider_scope_expansion =
        if request_local_scope == V3RequestLocalProviderFailureScope::Provider {
            let expanded = match context.captured_target_09 {
                Some(captured) => Ok(captured.clone()),
                None => expand_v3_relay_target_plan_for_selected(
                    context.manifest,
                    &selected,
                    context.deterministic_sample,
                )
                .map_err(|error| {
                    target_resolution_source(
                        "V3Target09CandidateSetExpanded",
                        "captured_target_plan_expansion_failed",
                        error,
                    )
                }),
            };
            Some(expanded)
        } else {
            None
        };
    let retries_done = state
        .same_candidate_retries
        .get(&candidate_key)
        .copied()
        .unwrap_or(0);
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    let resolution = match provider_scope_expansion {
        Some(Ok(expanded)) => {
            state
                .failed_candidates
                .extend(expand_request_local_provider_failure_scope(
                    request_local_scope,
                    &selected,
                    &expanded,
                ));
            excluded_with_failed = state.failed_candidates.clone();
            excluded_with_failed.insert(candidate_key.clone());
            reselect_from_captured_target_plan(
                context,
                &selected,
                &excluded_with_failed,
                v3_relay_provider_policy_now_epoch_ms()?,
            )
            .await
        }
        Some(Err(source)) => V3RelayProviderTargetResolution::Failed(source),
        None => {
            reselect_from_captured_target_plan(
                context,
                &selected,
                &excluded_with_failed,
                v3_relay_provider_policy_now_epoch_ms()?,
            )
            .await
        }
    };
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
                            .record_provider_action_failure_in_scope(
                                &context.failure_session_scope,
                                &selected.candidate.provider_id,
                                Some(&selected.candidate.auth_alias),
                                Some(&selected.candidate.model_id),
                                error_type.as_deref().unwrap_or("provider_failure"),
                            )?
                    } else {
                        context
                            .provider_health
                            .record_provider_action_failure_in_scope_with_minimum_delay(
                                &context.failure_session_scope,
                                &selected.candidate.provider_id,
                                Some(&selected.candidate.auth_alias),
                                Some(&selected.candidate.model_id),
                                error_type.as_deref().unwrap_or("provider_failure"),
                                configured_backoff_ms,
                            )?
                    })
                };
                let decision = build_v3_relay_provider_error_05_decision(
                    &selected,
                    source_stage,
                    status,
                    error_type.as_deref(),
                    &message,
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
                    },
                ),
            });
        }
    };
    if is_request_local_compat_failure {
        state.failed_candidates.insert(candidate_key);
        let decision = build_v3_relay_provider_error_05_decision(
            &selected,
            source_stage,
            status,
            error_type.as_deref(),
            &message,
            0,
            false,
            false,
            None,
        );
        return Ok(V3RelayProviderFailurePolicyResult {
            terminal_projection: terminal_projection_for(&decision, matched_policy),
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
        source_stage,
        status,
        error_type.as_deref(),
        &message,
        0,
        false,
        false,
        None,
    );
    let admission = context
        .provider_health
        .wait_for_terminal_provider_projection_in_scope(
            &context.failure_session_scope,
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            error_type.as_deref().unwrap_or("provider_failure"),
        )
        .await?;
    Ok(V3RelayProviderFailurePolicyResult {
        terminal_projection: terminal_projection_for(&decision, matched_policy),
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
            },
        ),
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
) -> Result<Option<V3ProviderFailurePolicy>, String> {
    let failure_threshold = policy
        .path
        .iter()
        .find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry { max_attempts, .. } => {
                Some((*max_attempts).max(1))
            }
            _ => None,
        })
        .unwrap_or(1);
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
    if scope != V3ProviderErrorActionScope::AuthKey {
        // V3 provider health only implements auth_key policy cooldowns today.
        // Other scopes keep the existing generic key-health path rather than
        // being silently remapped to auth_key.
        return Ok(None);
    }
    Ok(Some(V3ProviderFailurePolicy {
        failure_threshold,
        cooldown_ms: duration_ms.unwrap_or(1),
        probe_interval_ms: 5_000,
        max_probe_interval_ms: Some(
            duration_ms.unwrap_or(v3_internal_error_handling().unrecoverable_probe_interval_ms),
        ),
        long_probe_backoff: matches!(status, 401 | 402 | 403 | 503),
        until_restart: until_restart.unwrap_or(false),
        cooldown_scope: V3ProviderFailureCooldownScope::AuthKey,
    }))
}

fn build_v3_relay_provider_error_05_decision(
    selected: &V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    status: u16,
    error_type: Option<&str>,
    message: &str,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> V3Error05ExecutionDecision {
    let code = error_type.unwrap_or("provider_failure").to_string();
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        source_stage,
        code.clone(),
        message,
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(status),
            code: Some(code),
            provider_id: Some(selected.candidate.provider_id.clone()),
            upstream_request_id: None,
            message: Some(message.to_string()),
        },
    );
    V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source,
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: selected.candidate.provider_id.clone(),
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

fn build_v3_relay_target_candidates(
    input: &V3RelayProviderTargetResolutionInput<'_>,
) -> Result<V3Target09CandidateSetExpanded, V3RelayProviderTargetResolution> {
    let facts = crate::build_v3_router_request_facts_for_entry_with_manifest(
        input.body,
        input.entry_kind,
        crate::configured_v3_longcontext_threshold_tokens(input.manifest, input.server_id),
        input.manifest,
    );
    let router = V3VirtualRouter::process_shared();
    let classified = match router.classify_request_with_facts(
        input.manifest,
        input.server_id,
        input.endpoint_path,
        facts,
    ) {
        Ok(classified) => classified,
        Err(error) => {
            return Err(V3RelayProviderTargetResolution::Failed(
                target_resolution_source(
                    "V3Router05RequestClassified",
                    "target_resolution_classification_failed",
                    error,
                ),
            ));
        }
    };
    let plan = match router.resolve_route_pool_plan(input.manifest, classified) {
        Ok(plan) => plan,
        Err(error) => {
            return Err(V3RelayProviderTargetResolution::Failed(
                crate::shared::v3_route_plan_error_source(
                    "V3Router06RoutePoolResolved",
                    "target_resolution_route_plan_failed",
                    error,
                ),
            ));
        }
    };
    let hit = match router.hit_opaque_target_plan_once(plan, input.deterministic_sample) {
        Ok(hit) => hit,
        Err(error) => {
            return Err(V3RelayProviderTargetResolution::Failed(
                target_resolution_source(
                    "V3Router07OpaqueTargetHitOnce",
                    "target_resolution_opaque_target_failed",
                    error,
                ),
            ));
        }
    };
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    let expanded = match target.expand_candidates(input.manifest, kind, input.deterministic_sample)
    {
        Ok(expanded) => expanded,
        Err(error) => {
            return Err(V3RelayProviderTargetResolution::Failed(
                target_resolution_source(
                    "V3Target09CandidateSetExpanded",
                    "target_resolution_candidate_expansion_failed",
                    error,
                ),
            ));
        }
    };
    Ok(expanded)
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
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

pub(crate) fn v3_relay_provider_candidate_key_parts(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
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
