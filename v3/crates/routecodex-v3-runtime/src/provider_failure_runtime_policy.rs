use futures_util::future::join_all;
use routecodex_v3_config::internal::classify_v3_internal_provider_error;
use routecodex_v3_config::internal::v3_internal_error_handling;
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ProviderDispositionStepManifest,
    V3ProviderErrorActionPolicyManifest, V3ProviderErrorActionScope, V3ProviderErrorRetryMode,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_02_classified_from_v3_error_01,
    build_v3_provider_failure_action_from_v3_error_02, build_v3_provider_global_failure_policy,
    V3Error01SourceRaised, V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness,
    V3Error06ClientProjected, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_global_probe_request, ReqwestResponsesTransport, ResponsesTransport,
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderAvailabilityProjection,
    V3ProviderAvailabilityReader, V3ProviderError, V3ProviderFailureAction,
    V3ProviderFailureCooldownScope, V3ProviderFailurePolicy, V3ProviderFailureRecord,
    V3ProviderGlobalSubscriptionDecision, V3ProviderGlobalSubscriptionPolicy,
    V3ProviderHealthStore, V3ProviderRecoveryKind, V3ProviderSchedulingProjection,
    V3ProviderSchedulingReader, V3ProviderSessionAvailabilityReader, V3ResponsesProviderTarget,
};
use routecodex_v3_target::{
    V3Target09CandidateSetExpanded, V3Target10ConcreteProviderSelected, V3TargetCandidate,
    V3TargetExhaustion, V3TargetInterpreter,
};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;

use crate::provider_action_gate::{
    V3ProviderActionAdmission, V3ProviderActionFailureRecorded, V3ProviderActionGate,
    V3ProviderActionGateKey, V3ProviderActionProviderScope, V3ProviderActionRecoveryTransition,
};
use crate::provider_error_policy_matching::provider_error_policy_matches_source_failure;
pub use crate::provider_failure_global_probe::build_v3_provider_global_probe_target;
pub(crate) use crate::provider_failure_global_probe::probe_v3_provider_global_target_impl;

pub async fn probe_v3_provider_global_target(
    target: V3ResponsesProviderTarget,
) -> Result<(), String> {
    probe_v3_provider_global_target_impl(target).await
}

pub(crate) use crate::provider_failure_runtime_helpers::{
    build_v3_transient_failure_record, build_v3_transient_recovery_witness,
    V3_TRANSIENT_RETRY_BUDGET,
};

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
            same_candidate_retries: 0,
        }
    }
}

impl V3RelayProviderFailureRetryPolicy {
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        let same_candidate_retries = manifest
            .error
            .provider_error_default_path
            .iter()
            .find_map(|step| match step {
                V3ProviderDispositionStepManifest::WaitRetry { max_attempts, .. } => {
                    Some(max_attempts.saturating_sub(1) as usize)
                }
                _ => None,
            })
            .unwrap_or(0);
        Self {
            same_candidate_retries,
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
        let excluded = self
            .excluded
            .contains(&v3_relay_provider_candidate_key_parts(
                provider_id,
                Some(auth_alias),
                Some(model_id),
            ));
        let session_has_cooldown = session
            .blocked_scopes
            .iter()
            .any(|scope| scope.starts_with("provider_failure_session:"));
        projection.blocked_scopes.extend(session.blocked_scopes);
        if session_has_cooldown
            && !projection
                .blocked_scopes
                .iter()
                .any(|scope| scope == "provider_cooldown_probe_pending")
        {
            projection
                .blocked_scopes
                .push("provider_cooldown_probe_pending".to_string());
        }
        if excluded {
            projection
                .blocked_scopes
                .push("request_local_provider_failure".to_string());
        }
        projection.available = projection.available && session.available && !excluded;
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
    ) -> Result<(), String> {
        let (Some(auth_alias), Some(model_id)) = (auth_alias, model_id) else {
            if action.recovery != V3ProviderRecoveryKind::NotProviderHealth {
                return Err(format!(
                    "provider health action {} requires complete key identity: provider={provider_id} auth_alias={auth_alias:?} model_id={model_id:?}",
                    action.class_code
                ));
            }
            return Ok(());
        };
        if action.recovery == V3ProviderRecoveryKind::IrrecoverableGlobalCooldown {
            self.store
                .record_provider_cooldown_failure(
                    provider_id,
                    Some(auth_alias),
                    Some(model_id),
                    action.class_code.as_str(),
                    now_ms,
                    action.cooldown_ms,
                )
                .map_err(|error| error.to_string())?;
        }
        self.store
            .record_provider_failure_action(provider_id, auth_alias, model_id, action, now_ms)
            .map(|_| ())
    }

    pub(crate) fn record_provider_global_subscription_failure(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        fingerprint: routecodex_v3_error::V3ProviderErrorFingerprint,
        cooldown_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<V3ProviderGlobalSubscriptionDecision, String> {
        let policy = if let Some(cooldown_ms) = cooldown_ms {
            if cooldown_ms == 0 {
                return Err("provider global subscription cooldown must be non-zero".to_string());
            }
            V3ProviderGlobalSubscriptionPolicy {
                cooldown_ms,
                probe_interval_ms: cooldown_ms,
                ..V3ProviderGlobalSubscriptionPolicy::default()
            }
        } else {
            build_v3_provider_global_failure_policy(fingerprint.http_status)
                .map(|policy| V3ProviderGlobalSubscriptionPolicy {
                    failure_threshold: policy.failure_threshold,
                    cooldown_ms: policy.cooldown_ms,
                    probe_interval_ms: policy.probe_interval_ms,
                })
                .ok_or_else(|| "unsupported provider global health error class".to_string())?
        };
        let record = self
            .store
            .record_provider_failure_in_session_with_policy(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                Some(fingerprint.reason_code.as_str()),
                now_ms,
                Some(V3ProviderFailurePolicy {
                    failure_threshold: policy.failure_threshold,
                    cooldown_ms: policy.cooldown_ms,
                    probe_interval_ms: policy.probe_interval_ms,
                    until_restart: false,
                    cooldown_scope: V3ProviderFailureCooldownScope::AuthKey,
                }),
            )
            .map_err(|error| error.to_string())?;
        if record.state == "cooldown" {
            Ok(V3ProviderGlobalSubscriptionDecision::ProviderBlocked {
                blocked_until_ms: record
                    .cooldown_until_ms
                    .ok_or_else(|| "adaptive provider cooldown missing deadline".to_string())?,
            })
        } else {
            Ok(V3ProviderGlobalSubscriptionDecision::SessionFailure {
                count: record.failure_count,
            })
        }
    }

    pub async fn run_due_global_subscription_probes<F, Fut>(
        &self,
        now_ms: u64,
        probe: F,
    ) -> Result<(), String>
    where
        F: Fn(String, Option<String>, Option<String>) -> Fut + Clone,
        Fut: Future<Output = Result<(), String>>,
    {
        let mut probe_errors = Vec::new();
        let mut permits = Vec::new();
        for (provider_id, auth_alias, model_id) in self
            .store
            .provider_cooldown_probe_keys_due(now_ms)
            .map_err(|error| error.to_string())?
        {
            if self
                .store
                .try_acquire_provider_cooldown_probe(
                    &provider_id,
                    auth_alias.as_deref(),
                    model_id.as_deref(),
                )
                .map_err(|error| error.to_string())?
            {
                permits.push((provider_id, auth_alias, model_id));
            }
        }
        let probe_results = join_all(permits.into_iter().map(
            |(provider_id, auth_alias, model_id)| {
                let probe = probe.clone();
                async move {
                    let result =
                        (&probe)(provider_id.clone(), auth_alias.clone(), model_id.clone()).await;
                    (provider_id, auth_alias, model_id, result)
                }
            },
        ))
        .await;
        for (provider_id, auth_alias, model_id, result) in probe_results {
            match result {
                Ok(()) => self
                    .store
                    .complete_provider_cooldown_probe_success_at(
                        &provider_id,
                        auth_alias.as_deref(),
                        model_id.as_deref(),
                        now_ms,
                    )
                    .map_err(|error| error.to_string())?,
                Err(error) => {
                    self.store
                        .complete_provider_cooldown_probe_failure(
                            &provider_id,
                            auth_alias.as_deref(),
                            model_id.as_deref(),
                            now_ms,
                        )
                        .map_err(|error| error.to_string())?;
                    probe_errors.push(format!(
                        "adaptive provider cooldown probe failed for {provider_id}: {error}"
                    ));
                }
            }
        }
        if probe_errors.is_empty() {
            Ok(())
        } else {
            Err(probe_errors.join("; "))
        }
    }

    pub async fn run_due_provider_key_health_probes<F, Fut>(
        &self,
        now_ms: u64,
        startup: bool,
        probe: F,
    ) -> Result<(), String>
    where
        F: Fn(String, String, String) -> Fut + Clone,
        Fut: Future<Output = Result<(), String>>,
    {
        let candidates = self.store.provider_key_health_probe_keys(now_ms, startup)?;
        let mut probe_errors = Vec::new();
        let mut permits = Vec::new();
        for (provider_id, auth_alias, model_id) in candidates {
            let Some(permit) = self.store.acquire_provider_key_health_probe(
                &provider_id,
                &auth_alias,
                &model_id,
            )?
            else {
                continue;
            };
            permits.push(permit);
        }
        let probe_results = join_all(permits.into_iter().map(|permit| {
            let probe = probe.clone();
            let expected_generation = permit.expected_generation();
            let provider_id = permit.provider_id().to_string();
            let auth_alias = permit.auth_alias().to_string();
            let model_id = permit.model_id().to_string();
            async move {
                let result =
                    (&probe)(provider_id.clone(), auth_alias.clone(), model_id.clone()).await;
                (
                    permit,
                    provider_id,
                    auth_alias,
                    model_id,
                    expected_generation,
                    result,
                )
            }
        }))
        .await;
        for (permit, provider_id, auth_alias, model_id, expected_generation, result) in
            probe_results
        {
            match result {
                Ok(()) => self
                    .store
                    .complete_provider_key_probe_success_at_generation(
                        permit.provider_id(),
                        permit.auth_alias(),
                        permit.model_id(),
                        now_ms,
                        Some(expected_generation),
                    )
                    .map(|_| ())?,
                Err(error) => {
                    self.store.complete_provider_key_probe_failure(
                        permit.provider_id(),
                        permit.auth_alias(),
                        permit.model_id(),
                        now_ms,
                    )?;
                    probe_errors.push(format!(
                        "persistent provider key probe failed for {}:{}:{}: {error}",
                        provider_id, auth_alias, model_id
                    ));
                }
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
        let record = self
            .store
            .record_provider_failure_in_session(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                reason,
                now_ms,
            )
            .map_err(|error| error.to_string())?;
        Ok(record)
    }

    pub(crate) fn record_provider_failure_record_with_policy(
        &self,
        matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
        manifest: &V3Config05ManifestPublished,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        provider_type: Option<&str>,
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
        let action = build_v3_provider_failure_action_from_v3_error_02(&classified);
        self.record_provider_key_failure_action(
            provider_id,
            auth_alias,
            model_id,
            &action,
            now_ms,
        )?;
        self.store
            .record_provider_failure_in_session_with_policy(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                reason,
                now_ms,
                configured_health_policy_for_failure(
                    matched_policy_directive,
                    manifest,
                    provider_id,
                    provider_type,
                    model_id,
                    status,
                    error_type,
                    message,
                ),
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
        // post-commit SSE 流失败只在当前 session/key 内记录；不能写 provider
        // 级共享 cooldown，否则一个断流会污染其他 session 和其他 key。
        self.record_provider_transient_bypass_in_session(
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
        let action = build_v3_provider_failure_action_from_v3_error_02(&classified);
        if action.recovery == V3ProviderRecoveryKind::HealthNeutralTransient {
            return self.record_post_commit_provider_stream_failure(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                &source.code,
                &source.message,
            );
        }
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
                    ));
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
        context.deterministic_sample,
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
    matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
) -> Result<V3RelayProviderFailurePolicyResult, String> {
    let candidate_key = v3_relay_provider_candidate_key(&selected.candidate);
    // 瞬态失败（SSE 流内/挂起）判定由错误处理中心按「阶段 + 类别」表达：
    // relay 侧在这里按同样的 stage/code 规则消费，直接驱动 health-neutral
    // 同 provider 重试（前 2 次静默，第 3 次失败一次回报再切），与入口脱耦。
    let transient = matches!(
        classify_v3_internal_provider_error(
            source_stage,
            status,
            error_type.as_deref().unwrap_or_default(),
        ),
        routecodex_v3_config::internal::V3InternalErrorCategory::Transient
    );
    let matched_policy = find_matching_provider_error_policy(
        context.manifest,
        &selected.candidate.provider_id,
        Some(&selected.candidate.provider_type),
        Some(&selected.candidate.model_id),
        status,
        error_type.as_deref(),
        &message,
    );
    let configured_same_candidate_retries = configured_retry_budget_for_failure(
        matched_policy,
        context.retry_policy.same_candidate_retries,
    );
    let transient_admission = if transient {
        Some(
            context
                .provider_health
                .wait_for_provider_action_failure_in_scope(
                    &context.failure_session_scope,
                    &selected.candidate.provider_id,
                    Some(&selected.candidate.auth_alias),
                    Some(&selected.candidate.model_id),
                    error_type.as_deref().unwrap_or("provider_sse_transient"),
                )
                .await?,
        )
    } else {
        None
    };
    let reason = (!message.trim().is_empty()).then_some(message.as_str());
    let is_request_local_compat_failure = source_stage == "ProviderReqCompat06ProviderCompat"
        || error_type.as_deref() == Some("provider_request_compat_error")
        // Provider semantic invalid-request responses describe this request,
        // not provider health.  Relay may surface them as a runtime 502 after
        // decoding an HTTP-200 SSE error event, so status alone is insufficient.
        || error_type.as_deref() == Some("invalid_request_error")
        // HTTP 400 is a request/provider-compatibility rejection (for example
        // context-window or wire-shape limits), not an account-health signal.
        // Keep it health-neutral so all keys do not enter cooldown for the
        // same request-shaped failure.
        || status == 400
        // 瞬态失败第 3 次尝试后：health-neutral 切 provider/terminal
        // （复用 request-local 的 synthetic health record + request-local
        // recovery witness，不写 provider health store）。
        || transient;
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
    let retries_done = state
        .same_candidate_retries
        .get(&candidate_key)
        .copied()
        .unwrap_or(0);
    if configured_retry_mode(matched_policy, context.retry_policy.same_candidate_retries)
        == Some(V3ProviderErrorRetryMode::RetrySame)
        && health_record.state != "cooldown"
        && retries_done < configured_same_candidate_retries
        && status != 400
        // HTTP 503 is an upstream availability signal.  Do not spend a
        // same-candidate retry budget on it; mark this candidate failed and
        // reselect immediately.
        && status != 503
    {
        state
            .same_candidate_retries
            .insert(candidate_key.clone(), retries_done.saturating_add(1));
        state.trace.push("V3TargetPolicyRetriedSame");
        let failure_record = context
            .provider_health
            .record_provider_action_failure_in_scope_with_minimum_delay(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                error_type.as_deref().unwrap_or("provider_failure"),
                configured_retry_backoff_ms(matched_policy, retries_done),
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
            Some(failure_record.recovery_witness()?),
        );
        return Ok(V3RelayProviderFailurePolicyResult {
            terminal_projection: terminal_projection_for(&decision, matched_policy),
            decision,
            retry_selected: Some(Box::new(selected.clone())),
            event: build_v3_relay_provider_failure_policy_event(
                V3RelayProviderFailurePolicyEventInput {
                    candidate: selected.candidate,
                    status,
                    error_type,
                    message,
                    health_record,
                    action: "policy_retry_same",
                    next_provider_key: Some(candidate_key),
                    wait_ms: Some(failure_record.minimum_delay_ms),
                },
            ),
        });
    }
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
                            wait_ms: recovery
                                .as_ref()
                                .map(|record| record.minimum_delay_ms)
                                .or_else(|| {
                                    transient_admission
                                        .as_ref()
                                        .map(|admission| admission.minimum_delay_ms)
                                }),
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
        if *retries_done >= configured_same_candidate_retries || status == 400 {
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
            .record_provider_action_failure_in_scope_with_minimum_delay(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                error_type.as_deref().unwrap_or("provider_failure"),
                configured_retry_backoff_ms(matched_policy, retries_done.saturating_sub(1)),
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
            terminal_projection: terminal_projection_for(&decision, matched_policy),
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
        && *retries_done < configured_same_candidate_retries
        // 400 客户端请求错误（如 context window 超限）重试结果必然相同：
        // 同一 provider 不重试，直接 reselect 到下一个候选。
        && status != 400
    {
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3TargetLocalRetried");
        let failure_record = context
            .provider_health
            .record_provider_action_failure_in_scope_with_minimum_delay(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                error_type.as_deref().unwrap_or("provider_failure"),
                configured_retry_backoff_ms(matched_policy, retries_done.saturating_sub(1)),
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
            terminal_projection: terminal_projection_for(&decision, matched_policy),
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

include!("provider_failure_runtime_policy_configured.rs");

/// 瞬态失败（SSE 流内/挂起）同 provider 重试预算：与
/// `V3_TRANSIENT_PROVIDER_RETRY_BUDGET` 一致（=2 次重试，
/// 共 3 次尝试）；第 3 次尝试仍失败才回报一次并切 provider。语义属于
/// provider 内部失败重试，与入口（direct/relay/chat）无关。
#[cfg(test)]
mod tests;
