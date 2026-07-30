use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_06_client_projected_from_v3_error_05, V3Error05ExecutionDecision,
    V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected, V3ErrorActionScope,
    V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3ExternalErrorKind,
    V3ExternalErrorLink,
};
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader, V3ProviderError,
    V3ProviderFailureRecord, V3ProviderHealthStore,
};
use routecodex_v3_target::{
    V3Target10ConcreteProviderSelected, V3TargetCandidate, V3TargetInterpreter,
};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use crate::provider_action_gate::{
    V3ProviderActionAdmission, V3ProviderActionFailureRecorded, V3ProviderActionGate,
    V3ProviderActionGateKey, V3ProviderActionProviderScope, V3ProviderActionRecoveryTransition,
};

pub(crate) const V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES: usize = 3;
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
    build_v3_error_06_client_projected_from_v3_error_05(
        decision
            .try_into_terminal()
            .expect("ClientDisconnected Error05 must be terminal"),
    )
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
    pub(crate) server_id: &'ctx str,
    pub(crate) entry_kind: &'ctx str,
    pub(crate) endpoint_path: &'ctx str,
    pub(crate) route_facts_body: &'ctx Value,
    pub(crate) provider_health: &'ctx V3ProviderFailureRuntimeHealth,
    pub(crate) retry_policy: V3RelayProviderFailureRetryPolicy,
    pub(crate) deterministic_sample: u64,
}

pub(crate) struct V3RelayProviderFailurePolicyState<'state> {
    pub(crate) failed_candidates: &'state mut BTreeSet<String>,
    pub(crate) same_candidate_retries: &'state mut BTreeMap<String, usize>,
    pub(crate) trace: &'state mut Vec<&'static str>,
}

pub(crate) struct V3RelayProviderTargetResolutionInput<
    'input,
    R: V3ProviderAvailabilityReader + ?Sized,
> {
    pub(crate) manifest: &'input V3Config05ManifestPublished,
    pub(crate) server_id: &'input str,
    pub(crate) entry_kind: &'input str,
    pub(crate) endpoint_path: &'input str,
    pub(crate) body: &'input Value,
    pub(crate) request_local_excluded_candidates: &'input BTreeSet<String>,
    pub(crate) provider_health: &'input R,
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
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, String> {
        self.store
            .record_provider_failure(provider_id, auth_alias, model_id, reason, now_ms)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_provider_success_in_scope(
        &self,
        server_id: &str,
        routing_group: &str,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        self.store
            .record_provider_success(provider_id, auth_alias, model_id, now_ms)
            .map_err(|error| error.to_string())?;
        self.action_gate
            .record_provider_success(&V3ProviderActionProviderScope::new(
                server_id,
                routing_group,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
            )?)
    }

    pub(crate) fn record_provider_action_failure(
        &self,
        server_id: &str,
        routing_group: &str,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        self.action_gate
            .record_failure(&V3ProviderActionGateKey::new(
                server_id,
                routing_group,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
                error_family,
            )?)
    }

    pub(crate) async fn wait_for_terminal_provider_projection(
        &self,
        server_id: &str,
        routing_group: &str,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
    ) -> Result<V3ProviderActionAdmission, String> {
        self.action_gate
            .record_failure_and_wait_for_terminal_projection(V3ProviderActionGateKey::new(
                server_id,
                routing_group,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
                error_family,
            )?)
            .await
    }

    pub(crate) fn record_post_commit_provider_stream_failure(
        &self,
        server_id: &str,
        routing_group: &str,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        error_family: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.record_provider_failure_record(
            provider_id,
            auth_alias,
            model_id,
            Some(reason),
            v3_relay_provider_policy_now_epoch_ms()?,
        )?;
        self.record_provider_action_failure(
            server_id,
            routing_group,
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
                    witness.server_id(),
                    witness.routing_group(),
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
        manifest: &V3Config05ManifestPublished,
        server_id: &str,
        selected: &V3Target10ConcreteProviderSelected,
    ) -> Result<Option<V3ProviderActionAdmission>, String> {
        let routing_group = manifest
            .servers
            .get(server_id)
            .map(|server| server.routing_group.as_str())
            .ok_or_else(|| format!("server {server_id} is missing"))?;
        self.action_gate
            .wait_for_exact_provider_action(&V3ProviderActionProviderScope::new(
                server_id,
                routing_group,
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
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                reason,
                v3_relay_provider_policy_now_epoch_ms()?,
            )
            .map_err(|error| error.to_string())?
    };
    let routing_group = context
        .manifest
        .servers
        .get(context.server_id)
        .map(|server| server.routing_group.as_str())
        .ok_or_else(|| format!("server {} is missing", context.server_id))?;
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    let resolution = resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest: context.manifest,
        server_id: context.server_id,
        entry_kind: context.entry_kind,
        endpoint_path: context.endpoint_path,
        body: context.route_facts_body,
        request_local_excluded_candidates: &excluded_with_failed,
        provider_health: context.provider_health,
        now_ms: v3_relay_provider_policy_now_epoch_ms()?,
        deterministic_sample: context.deterministic_sample,
    });
    let route_resolution_proved_no_alternative = match resolution {
        V3RelayProviderTargetResolution::Selected(alternative) => {
            let alternative_key = v3_relay_provider_candidate_key(&alternative.candidate);
            if alternative_key != candidate_key || !alternative.default_floor_protected {
                let request_local_recovery = || {
                    V3Error05RecoveryAdmissionWitness::new(
                        context.server_id,
                        routing_group,
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
                    Some(context.provider_health.record_provider_action_failure(
                        context.server_id,
                        routing_group,
                        &selected.candidate.provider_id,
                        Some(&selected.candidate.auth_alias),
                        Some(&selected.candidate.model_id),
                        error_type.as_deref().unwrap_or("provider_failure"),
                    )?)
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
    if selected.default_floor_protected || selected.candidate.default_pool_member {
        let retries_done = state
            .same_candidate_retries
            .entry(candidate_key.clone())
            .or_insert(0);
        if *retries_done >= context.retry_policy.same_candidate_retries {
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
                .wait_for_terminal_provider_projection(
                    context.server_id,
                    routing_group,
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
        let failure_record = context.provider_health.record_provider_action_failure(
            context.server_id,
            routing_group,
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
    if *retries_done < context.retry_policy.same_candidate_retries {
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3TargetLocalRetried");
        let failure_record = context.provider_health.record_provider_action_failure(
            context.server_id,
            routing_group,
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
        .wait_for_terminal_provider_projection(
            context.server_id,
            routing_group,
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
    decision
        .clone()
        .try_into_terminal()
        .ok()
        .map(build_v3_error_06_client_projected_from_v3_error_05)
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

pub(crate) fn resolve_v3_relay_target<R: V3ProviderAvailabilityReader + ?Sized>(
    input: V3RelayProviderTargetResolutionInput<'_, R>,
) -> Result<V3Target10ConcreteProviderSelected, String> {
    match resolve_v3_relay_target_outcome(input) {
        V3RelayProviderTargetResolution::Selected(selected) => Ok(selected),
        V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates,
        } => Err(format!(
            "selected target exhausted after {attempted_candidates:?}"
        )),
        V3RelayProviderTargetResolution::Failed(source) => {
            Err(format!("{}: {}", source.code, source.message))
        }
    }
}

pub(crate) fn resolve_v3_relay_target_outcome<R: V3ProviderAvailabilityReader + ?Sized>(
    input: V3RelayProviderTargetResolutionInput<'_, R>,
) -> V3RelayProviderTargetResolution {
    let facts = crate::build_v3_router_request_facts_for_entry(
        input.body,
        input.entry_kind,
        crate::configured_v3_longcontext_threshold_tokens(input.manifest, input.server_id),
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
            return V3RelayProviderTargetResolution::Failed(target_resolution_source(
                "V3Router06RoutePoolResolved",
                "target_resolution_route_plan_failed",
                error,
            ))
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
    match target.select_available(
        expanded,
        &V3RelayExcludedAvailability {
            base: input.provider_health,
            excluded: input.request_local_excluded_candidates,
        },
        input.now_ms,
    ) {
        Ok(selected) => V3RelayProviderTargetResolution::Selected(selected),
        Err(exhausted) => V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates: exhausted.attempted_candidates,
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
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use serde_json::json;

    fn target_resolution_manifest(scope: &str) -> V3Config05ManifestPublished {
        let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "PRIMARY_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
"#
        .replace("__SCOPE__", scope);
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(&source).expect("target-resolution authoring"),
        )
        .expect("target-resolution manifest")
    }

    fn resolve_target(
        manifest: &V3Config05ManifestPublished,
        server_id: &str,
        excluded: &BTreeSet<String>,
        health: &V3ProviderFailureRuntimeHealth,
    ) -> V3RelayProviderTargetResolution {
        resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
            manifest,
            server_id,
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            body: &json!({"model":"client-responses","input":"hello"}),
            request_local_excluded_candidates: excluded,
            provider_health: health,
            now_ms: 1,
            deterministic_sample: 0,
        })
    }

    fn assert_resolution_failure(
        resolution: V3RelayProviderTargetResolution,
        expected_stage: &str,
        expected_code: &str,
    ) {
        let V3RelayProviderTargetResolution::Failed(source) = resolution else {
            panic!("expected independent target-resolution source failure");
        };
        assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
        assert_eq!(source.source_stage, expected_stage);
        assert_eq!(source.code, expected_code);
    }

    #[test]
    fn classifier_failure_preserves_its_own_error01_stage_and_code() {
        let manifest = target_resolution_manifest("resolution_classifier");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

        assert_resolution_failure(
            resolve_target(&manifest, "missing-server", &BTreeSet::new(), &health),
            "V3Router05RequestClassified",
            "target_resolution_classification_failed",
        );
    }

    #[test]
    fn route_plan_failure_preserves_its_own_error01_stage_and_code() {
        let mut manifest = target_resolution_manifest("resolution_plan");
        manifest
            .route_groups
            .get_mut("resolution_plan")
            .expect("route group")
            .pools
            .remove("default");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

        assert_resolution_failure(
            resolve_target(&manifest, "resolution_plan", &BTreeSet::new(), &health),
            "V3Router06RoutePoolResolved",
            "target_resolution_route_plan_failed",
        );
    }

    #[test]
    fn candidate_expansion_failure_preserves_its_own_error01_stage_and_code() {
        let mut manifest = target_resolution_manifest("resolution_expand");
        manifest.providers.remove("primary");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

        assert_resolution_failure(
            resolve_target(&manifest, "resolution_expand", &BTreeSet::new(), &health),
            "V3Target09CandidateSetExpanded",
            "target_resolution_candidate_expansion_failed",
        );
    }

    #[test]
    fn unavailable_candidate_is_exhaustion_not_runtime_failure() {
        let manifest = target_resolution_manifest("resolution_exhausted");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let mut excluded = BTreeSet::new();
        excluded.insert(v3_relay_provider_candidate_key_parts(
            "primary",
            Some("key1"),
            Some("gpt-test"),
        ));

        let V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates,
        } = resolve_target(&manifest, "resolution_exhausted", &excluded, &health)
        else {
            panic!("unavailable selected candidates must produce typed exhaustion");
        };
        assert!(!attempted_candidates.is_empty());
    }

    #[tokio::test]
    async fn request_local_provider_compat_default_floor_exhausts_without_wait_or_health_mutation()
    {
        let manifest = target_resolution_manifest("compat_default_floor");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let selected =
            match resolve_target(&manifest, "compat_default_floor", &BTreeSet::new(), &health) {
                V3RelayProviderTargetResolution::Selected(selected) => selected,
                _ => panic!("valid fixture must select the default-floor provider"),
            };
        let mut failed_candidates = BTreeSet::new();
        let mut same_candidate_retries = BTreeMap::new();
        let mut trace = Vec::new();
        let route_facts_body = json!({"model":"client-responses","input":"hello"});
        let context = V3RelayProviderFailurePolicyContext {
            manifest: &manifest,
            server_id: "compat_default_floor",
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            route_facts_body: &route_facts_body,
            provider_health: &health,
            retry_policy: V3RelayProviderFailureRetryPolicy::default(),
            deterministic_sample: 0,
        };
        let mut state = V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        };

        let result = run_v3_relay_provider_failure_policy(
            &context,
            selected,
            "ProviderReqCompat06ProviderCompat",
            502,
            Some("provider_request_compat_error".to_string()),
            "arguments must be valid JSON".to_string(),
            &mut state,
        )
        .await
        .expect("request-local compat exhaustion must project without recovery wait");

        assert_eq!(
            result.event.health_record.state,
            "request_local_provider_compat"
        );
        assert_eq!(result.event.health_record.failure_count, 0);
        assert_eq!(result.event.health_record.cooldown_until_ms, None);
        assert_eq!(result.event.wait_ms, None);
        assert_eq!(
            result.event.action,
            "terminal_request_local_provider_compat_exhausted"
        );
        assert!(result.retry_selected.is_none());
        assert!(result.terminal_projection.is_some());
        assert!(state.same_candidate_retries.is_empty());
    }

    #[tokio::test]
    async fn target_resolution_failure_projects_itself_instead_of_prior_provider_429() {
        let mut manifest = target_resolution_manifest("resolution_policy");
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let selected =
            match resolve_target(&manifest, "resolution_policy", &BTreeSet::new(), &health) {
                V3RelayProviderTargetResolution::Selected(selected) => selected,
                _ => panic!("valid fixture must select a provider"),
            };
        manifest
            .route_groups
            .get_mut("resolution_policy")
            .expect("route group")
            .pools
            .remove("default");
        let mut failed_candidates = BTreeSet::new();
        let mut same_candidate_retries = BTreeMap::new();
        let mut trace = Vec::new();
        let route_facts_body = json!({"model":"client-responses","input":"hello"});
        let context = V3RelayProviderFailurePolicyContext {
            manifest: &manifest,
            server_id: "resolution_policy",
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            route_facts_body: &route_facts_body,
            provider_health: &health,
            retry_policy: V3RelayProviderFailureRetryPolicy::default(),
            deterministic_sample: 0,
        };
        let mut state = V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        };

        let result = run_v3_relay_provider_failure_policy(
            &context,
            selected,
            "V3ProviderRespInbound01Raw",
            429,
            Some("rate_limit".to_string()),
            "prior provider returned 429".to_string(),
            &mut state,
        )
        .await
        .expect("target-resolution source failure must remain projectable");

        assert_eq!(
            result
                .decision
                .exhaustion
                .local_action
                .classified
                .source
                .code,
            "target_resolution_route_plan_failed"
        );
        assert_eq!(
            result
                .decision
                .exhaustion
                .local_action
                .classified
                .source
                .source_stage,
            "V3Router06RoutePoolResolved"
        );
        let projection = result
            .terminal_projection
            .expect("non-provider target-resolution failure is terminal");
        assert_eq!(projection.status, 500);
        assert_ne!(projection.status, 429);
        assert_eq!(
            projection.body["error"]["code"],
            "target_resolution_route_plan_failed"
        );
        assert!(!projection
            .body
            .to_string()
            .contains("prior provider returned 429"));
    }
}
