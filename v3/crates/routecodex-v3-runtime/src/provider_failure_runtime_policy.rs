use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader, V3ProviderError,
    V3ProviderFailureRecord, V3ProviderHealthStore, V3ProviderSessionAvailabilityReader,
};
use routecodex_v3_target::{
    V3Target09CandidateSetExpanded, V3Target10ConcreteProviderSelected, V3TargetCandidate,
    V3TargetExhaustion, V3TargetInterpreter,
};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use crate::provider_action_gate::{
    V3ProviderActionAdmission, V3ProviderActionFailureRecorded, V3ProviderActionGate,
    V3ProviderActionGateKey, V3ProviderActionProviderScope, V3ProviderActionRecoveryTransition,
};

pub(crate) const V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES: usize = 3;
/// 同 provider retry budget（policy 输入，非决策）：与
/// `direct_runtime_helpers.rs` 的 direct 侧口径保持一致；两侧都只计算
/// `remaining` 候选数交给 Error05 中心决策，不在这里做 reroute/cooldown 判定。
pub(crate) const V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET: usize =
    V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES - 1;

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
            same_candidate_retries: V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET,
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

struct V3RelayExcludedAvailability<
    'availability,
    'excluded,
    R: V3ProviderAvailabilityReader + ?Sized,
> {
    base: &'availability R,
    excluded: &'excluded BTreeSet<String>,
}

pub(crate) fn select_v3_target_with_session_then_global(
    target: &V3TargetInterpreter,
    expanded: V3Target09CandidateSetExpanded,
    session_availability: &V3ProviderSessionAvailabilityReader,
    global_availability: &V3ProviderFailureRuntimeHealth,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
    let session_selected = target.select_available(
        expanded.clone(),
        &V3RelayExcludedAvailability {
            base: session_availability,
            excluded: request_local_excluded_candidates,
        },
        now_ms,
    );
    let has_global_alternative = expanded.candidates.len() > 1
        && expanded.candidates.iter().any(|candidate| {
            let key = v3_relay_provider_candidate_key(candidate);
            !request_local_excluded_candidates.contains(&key)
                && global_availability
                    .availability(
                        &candidate.provider_id,
                        Some(&candidate.auth_alias),
                        Some(&candidate.model_id),
                        now_ms,
                    )
                    .available
        });
    if !has_global_alternative {
        return session_selected;
    }
    if session_selected
        .as_ref()
        .is_ok_and(|selected| !selected.default_floor_protected)
    {
        return session_selected;
    }
    target.select_available(
        expanded,
        &V3RelayExcludedAvailability {
            base: global_availability,
            excluded: request_local_excluded_candidates,
        },
        now_ms,
    )
}

struct V3RevivedCandidateAvailability<'availability> {
    session: &'availability V3ProviderSessionAvailabilityReader,
    global: &'availability V3ProviderFailureRuntimeHealth,
    revived_candidate_key: &'availability str,
}

impl V3ProviderAvailabilityReader for V3RevivedCandidateAvailability<'_> {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        if v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id)
            == self.revived_candidate_key
        {
            return self
                .global
                .availability(provider_id, auth_alias, model_id, now_ms);
        }
        self.session
            .availability(provider_id, auth_alias, model_id, now_ms)
    }
}

pub(crate) fn try_reselect_cross_session_revive_from_captured_candidates(
    provider_health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    expanded: &routecodex_v3_target::V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
) -> Result<Option<V3Target10ConcreteProviderSelected>, String> {
    let session_availability = provider_health.session_bound_availability(failure_session_scope);
    for candidate in &expanded.candidates {
        let candidate_key = v3_relay_provider_candidate_key(&candidate);
        if request_local_excluded_candidates.contains(&candidate_key)
            || !provider_health
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    now_ms,
                )
                .available
        {
            continue;
        }
        let admitted = provider_health
            .store()
            .try_acquire_cross_session_revive(
                failure_session_scope,
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                now_ms,
            )
            .map_err(|error| error.to_string())?
            .is_some();
        if !admitted {
            continue;
        }
        let revived_availability = V3RevivedCandidateAvailability {
            session: &session_availability,
            global: provider_health,
            revived_candidate_key: &candidate_key,
        };
        return V3TargetInterpreter::default()
            .select_available(expanded.clone(), &revived_availability, now_ms)
            .map(Some)
            .map_err(|error| {
                format!(
                    "atomic revive candidate {candidate_key} could not be selected from captured plan: {:?}",
                    error.attempted_candidates
                )
            });
    }
    Ok(None)
}

impl<R: V3ProviderAvailabilityReader + ?Sized> V3ProviderAvailabilityReader
    for V3RelayExcludedAvailability<'_, '_, R>
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
        let key = v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id);
        if self.excluded.contains(&key) {
            projection.available = false;
            projection
                .blocked_scopes
                .push("request_local_provider_failure".to_string());
        }
        projection
    }
}

#[derive(Debug, Clone)]
pub struct V3ProviderFailureRuntimeHealth {
    store: V3ProviderHealthStore,
    action_gate: V3ProviderActionGate,
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest(manifest),
            action_gate: V3ProviderActionGate::process_shared(),
        }
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

    pub(crate) fn record_provider_success_in_failure_scope(
        &self,
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
        self.action_gate
            .record_provider_success(&V3ProviderActionProviderScope::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
            )?)
    }

    pub(crate) fn record_provider_action_failure_in_scope(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.action_gate
            .record_failure(&V3ProviderActionGateKey::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
                error_family,
            )?)
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
            .record_failure_and_wait_for_terminal_projection(V3ProviderActionGateKey::new(
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
        error_family: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.record_provider_failure_record(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            Some(reason),
            v3_relay_provider_policy_now_epoch_ms()?,
        )?;
        self.record_provider_action_failure_in_scope(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            error_family,
        )?;
        Ok(())
    }

    pub(crate) async fn wait_for_error05_recovery(
        &self,
        witness: &V3Error05RecoveryAdmissionWitness,
        selected: &V3Target10ConcreteProviderSelected,
    ) -> Result<V3ProviderActionRecoveryTransition, String> {
        self.action_gate
            .wait_for_recovery_witness(
                witness,
                V3ProviderActionProviderScope::new(
                    witness.failure_session_scope(),
                    v3_relay_provider_candidate_key_parts(
                        &selected.candidate.provider_id,
                        Some(&selected.candidate.auth_alias),
                        Some(&selected.candidate.model_id),
                    ),
                )?,
            )
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
    ) -> V3ProviderSessionAvailabilityReader {
        V3ProviderSessionAvailabilityReader::new(self.store.clone(), failure_session_scope.clone())
    }
}

impl From<V3ProviderHealthStore> for V3ProviderFailureRuntimeHealth {
    fn from(store: V3ProviderHealthStore) -> Self {
        Self {
            store,
            action_gate: V3ProviderActionGate::process_shared(),
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

fn reselect_from_captured_target_plan(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: &V3Target10ConcreteProviderSelected,
    request_local_excluded_candidates: &BTreeSet<String>,
    now_ms: u64,
) -> V3RelayProviderTargetResolution {
    let target = V3TargetInterpreter::default();
    let expanded = match context.captured_target_09 {
        Some(expanded) => expanded.clone(),
        None => {
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
                    ))
                }
            }
        }
    };
    let session_bound_availability = context
        .provider_health
        .session_bound_availability(&context.failure_session_scope);
    match select_v3_target_with_session_then_global(
        &target,
        expanded,
        &session_bound_availability,
        context.provider_health,
        request_local_excluded_candidates,
        now_ms,
    ) {
        Ok(selected) => V3RelayProviderTargetResolution::Selected(selected),
        Err(exhausted) => V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates: exhausted.attempted_candidates,
        },
    }
}

pub(crate) async fn run_v3_relay_provider_failure_policy(
    context: &V3RelayProviderFailurePolicyContext<'_>,
    selected: V3Target10ConcreteProviderSelected,
    source_stage: &'static str,
    status: u16,
    error_type: Option<String>,
    message: String,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
) -> Result<V3RelayProviderFailurePolicyResult, String> {
    let candidate_key = v3_relay_provider_candidate_key(&selected.candidate);
    let reason = (!message.trim().is_empty()).then_some(message.as_str());
    let is_request_local_compat_failure = source_stage == "ProviderReqCompat06ProviderCompat"
        || error_type.as_deref() == Some("provider_request_compat_error");
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
            .record_provider_failure_record(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                reason,
                v3_relay_provider_policy_now_epoch_ms()?,
            )
            .map_err(|error| error.to_string())?
    };
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    let resolution = reselect_from_captured_target_plan(
        context,
        &selected,
        &excluded_with_failed,
        v3_relay_provider_policy_now_epoch_ms()?,
    );
    let route_resolution_proved_no_alternative = match resolution {
        V3RelayProviderTargetResolution::Selected(alternative) => {
            let alternative_key = v3_relay_provider_candidate_key(&alternative.candidate);
            if alternative_key != candidate_key || !alternative.default_floor_protected {
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
                    Some(
                        context
                            .provider_health
                            .record_provider_action_failure_in_scope(
                                &context.failure_session_scope,
                                &selected.candidate.provider_id,
                                Some(&selected.candidate.auth_alias),
                                Some(&selected.candidate.model_id),
                                error_type.as_deref().unwrap_or("provider_failure"),
                            )?,
                    )
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
                    terminal_projection: terminal_projection_for(&decision),
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
            attempted_candidates,
        } => {
            let _ = attempted_candidates;
            if !is_request_local_compat_failure
                // 400/InvalidRequest 不触发 cross-session revive：重试结果必然
                // 相同（客户端请求错误），直接走 terminal（与普通分支 400 拦截对齐）。
                && status != 400
                && context
                    .provider_health
                    .store()
                    .try_acquire_cross_session_revive(
                        &context.failure_session_scope,
                        &selected.candidate.provider_id,
                        Some(&selected.candidate.auth_alias),
                        Some(&selected.candidate.model_id),
                        v3_relay_provider_policy_now_epoch_ms()?,
                    )
                    .map_err(|error| error.to_string())?
                    .is_some()
            {
                let recovery = context
                    .provider_health
                    .record_provider_action_failure_in_scope(
                        &context.failure_session_scope,
                        &selected.candidate.provider_id,
                        Some(&selected.candidate.auth_alias),
                        Some(&selected.candidate.model_id),
                        error_type.as_deref().unwrap_or("provider_failure"),
                    )?;
                let decision = build_v3_relay_provider_error_05_decision(
                    &selected,
                    source_stage,
                    status,
                    error_type.as_deref(),
                    &message,
                    0,
                    selected.candidate.default_pool_member,
                    true,
                    Some(recovery.recovery_witness()?),
                );
                state.trace.push("V3CrossSessionReviveAdmitted");
                return Ok(V3RelayProviderFailurePolicyResult {
                    terminal_projection: terminal_projection_for(&decision),
                    decision,
                    retry_selected: Some(Box::new(selected.clone())),
                    event: build_v3_relay_provider_failure_policy_event(
                        V3RelayProviderFailurePolicyEventInput {
                            candidate: selected.candidate,
                            status,
                            error_type,
                            message,
                            health_record,
                            action: "cross_session_revive",
                            next_provider_key: Some(candidate_key),
                            wait_ms: Some(recovery.minimum_delay_ms),
                        },
                    ),
                });
            }
            true
        }
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
                terminal_projection: terminal_projection_for(&decision),
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
            terminal_projection: terminal_projection_for(&decision),
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
    if health_record.state != "cooldown"
        && (selected.default_floor_protected || selected.candidate.default_pool_member)
    {
        let retries_done = state
            .same_candidate_retries
            .entry(candidate_key.clone())
            .or_insert(0);
        // 400/InvalidRequest（客户端请求错误，如 context window 超限）重试结果
        // 必然相同：同一 provider 不重试。与普通分支(874-877)对齐——default floor
        // 分支同样拦截 400，避免 asxs-grok 等 default 池成员 400 被同 provider
        // 重试多次才 terminal。
        if *retries_done >= context.retry_policy.same_candidate_retries || status == 400 {
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
            return Ok(V3RelayProviderFailurePolicyResult {
                terminal_projection: terminal_projection_for(&decision),
                decision,
                retry_selected: None,
                event: build_v3_relay_provider_failure_policy_event(
                    V3RelayProviderFailurePolicyEventInput {
                        candidate: selected.candidate,
                        status,
                        error_type,
                        message,
                        health_record,
                        action: "terminal_default_floor_exhausted",
                        next_provider_key: None,
                        wait_ms: Some(admission.minimum_delay_ms),
                    },
                ),
            });
        }
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3DefaultFloorBackoffWait");
        let failure_record = context
            .provider_health
            .record_provider_action_failure_in_scope(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                error_type.as_deref().unwrap_or("provider_failure"),
            )?;
        let wait_ms = failure_record.minimum_delay_ms;
        let decision = build_v3_relay_provider_error_05_decision(
            &selected,
            source_stage,
            status,
            error_type.as_deref(),
            &message,
            0,
            true,
            true,
            Some(failure_record.recovery_witness()?),
        );
        return Ok(V3RelayProviderFailurePolicyResult {
            terminal_projection: terminal_projection_for(&decision),
            decision,
            retry_selected: Some(Box::new(selected.clone())),
            event: build_v3_relay_provider_failure_policy_event(
                V3RelayProviderFailurePolicyEventInput {
                    candidate: selected.candidate,
                    status,
                    error_type,
                    message,
                    health_record,
                    action: "default_floor_retry_wait",
                    next_provider_key: Some(candidate_key),
                    wait_ms: Some(wait_ms),
                },
            ),
        });
    }
    let retries_done = state
        .same_candidate_retries
        .entry(candidate_key.clone())
        .or_insert(0);
    if health_record.state != "cooldown"
        && *retries_done < context.retry_policy.same_candidate_retries
        // 400 客户端请求错误（如 context window 超限）重试结果必然相同：
        // 同一 provider 不重试，直接 reselect 到下一个候选。
        && status != 400
    {
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3TargetLocalRetried");
        let failure_record = context
            .provider_health
            .record_provider_action_failure_in_scope(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                error_type.as_deref().unwrap_or("provider_failure"),
            )?;
        let wait_ms = Some(failure_record.minimum_delay_ms);
        let decision = build_v3_relay_provider_error_05_decision(
            &selected,
            source_stage,
            status,
            error_type.as_deref(),
            &message,
            0,
            false,
            true,
            Some(failure_record.recovery_witness()?),
        );
        return Ok(V3RelayProviderFailurePolicyResult {
            terminal_projection: terminal_projection_for(&decision),
            decision,
            retry_selected: Some(Box::new(selected.clone())),
            event: build_v3_relay_provider_failure_policy_event(
                V3RelayProviderFailurePolicyEventInput {
                    candidate: selected.candidate,
                    status,
                    error_type,
                    message,
                    health_record,
                    action: "retry_provider",
                    next_provider_key: Some(candidate_key),
                    wait_ms,
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
        terminal_projection: terminal_projection_for(&decision),
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
) -> Option<V3Error06ClientProjected> {
    // 非 terminal decision 携带 None 是合法 Option 状态（调用点仅在
    // ProjectTerminal 时消费，并以 expect 锁定不变量）；不允许静默吞错。
    decision
        .clone()
        .try_into_terminal()
        .ok()
        .map(V3ErrorHandlingCenter::project_terminal_decision)
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

pub(crate) fn resolve_v3_relay_target_outcome(
    input: V3RelayProviderTargetResolutionInput<'_>,
) -> V3RelayProviderTargetResolution {
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
            return V3RelayProviderTargetResolution::Failed(target_resolution_source(
                "V3Router05RequestClassified",
                "target_resolution_classification_failed",
                error,
            ))
        }
    };
    let plan = match router.resolve_route_pool_plan(input.manifest, classified) {
        Ok(plan) => plan,
        Err(error) => {
            return V3RelayProviderTargetResolution::Failed(
                crate::shared::v3_route_plan_error_source(
                    "V3Router06RoutePoolResolved",
                    "target_resolution_route_plan_failed",
                    error,
                ),
            )
        }
    };
    let hit = match router.hit_opaque_target_plan_once(plan, input.deterministic_sample) {
        Ok(hit) => hit,
        Err(error) => {
            return V3RelayProviderTargetResolution::Failed(target_resolution_source(
                "V3Router07OpaqueTargetHitOnce",
                "target_resolution_opaque_target_failed",
                error,
            ))
        }
    };
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    let expanded = match target.expand_candidates(input.manifest, kind, input.deterministic_sample)
    {
        Ok(expanded) => expanded,
        Err(error) => {
            return V3RelayProviderTargetResolution::Failed(target_resolution_source(
                "V3Target09CandidateSetExpanded",
                "target_resolution_candidate_expansion_failed",
                error,
            ))
        }
    };
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
    ) {
        Ok(selected) => V3RelayProviderTargetResolution::Selected(selected),
        Err(exhausted) => match try_reselect_cross_session_revive_from_captured_candidates(
            input.provider_health,
            input.failure_session_scope,
            &expanded,
            input.request_local_excluded_candidates,
            input.now_ms,
        ) {
            Ok(Some(selected)) => V3RelayProviderTargetResolution::Selected(selected),
            Ok(None) => V3RelayProviderTargetResolution::Exhausted {
                attempted_candidates: exhausted.attempted_candidates,
            },
            Err(error) => V3RelayProviderTargetResolution::Failed(target_resolution_source(
                "V3ProviderHealthStateMutated",
                "cross_session_revive_admission_failed",
                error,
            )),
        },
    }
}

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

struct V3RelayProviderFailurePolicyEventInput {
    candidate: V3TargetCandidate,
    status: u16,
    error_type: Option<String>,
    message: String,
    health_record: V3ProviderFailureRecord,
    action: &'static str,
    next_provider_key: Option<String>,
    wait_ms: Option<u64>,
}

fn build_v3_relay_provider_failure_policy_event(
    input: V3RelayProviderFailurePolicyEventInput,
) -> V3RelayProviderFailurePolicyEvent {
    V3RelayProviderFailurePolicyEvent {
        candidate: input.candidate,
        status: input.status,
        error_type: input.error_type,
        message: input.message,
        health_record: input.health_record,
        action: input.action.to_string(),
        next_provider_key: input.next_provider_key,
        wait_ms: input.wait_ms,
    }
}

pub(crate) fn v3_relay_provider_policy_now_epoch_ms() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("system time precedes Unix epoch: {error}"))
}

#[cfg(test)]
mod tests;
