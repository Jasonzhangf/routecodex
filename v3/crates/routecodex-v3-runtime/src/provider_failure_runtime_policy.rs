use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ProviderDispositionStepManifest,
    V3ProviderErrorActionPolicyManifest,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    V3Error05ExecutionDecision, V3Error05RecoveryAdmissionWitness, V3Error06ClientProjected,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3ProviderFailureSessionScope,
    is_v3_retryable_transient_stage_code,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_request_from_v3_provider_12,
    ReqwestResponsesTransport, ResponsesTransport,
    V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader, V3ProviderError,
    V3ProviderFailurePolicy, V3ProviderFailureRecord, V3ProviderHealthStore,
    V3ProviderSessionAvailabilityReader,
    V3ProviderGlobalSubscriptionDecision, V3ProviderGlobalSubscriptionHealthStore,
    V3ProviderGlobalSubscriptionPolicy,
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ResponsesProviderTarget,
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
pub(crate) use crate::provider_failure_runtime_helpers::{
    build_v3_transient_failure_record, build_v3_transient_recovery_witness,
    V3_TRANSIENT_RETRY_BUDGET,
};

pub fn build_v3_provider_global_probe_target(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> Result<V3ResponsesProviderTarget, String> {
    let provider = manifest
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("probe provider {provider_id} missing"))?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| auth_alias.is_none_or(|alias| entry.alias == alias))
        .ok_or_else(|| format!("probe provider {provider_id} has no auth entry"))?;
    let secret = match (&auth.env, &auth.token_file, &auth.secret_file, &auth.secret_key, &auth.api_key) {
        (Some(env), None, None, None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None, None, None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(path), Some(key), None) => V3ProviderAuthSecretHandle::SecretFile {
            path: path.clone(),
            key: key.clone(),
        },
        (None, None, None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => return Err(format!("probe provider {provider_id} auth entry is invalid")),
    };
    let model = provider
        .models
        .get(model_id.unwrap_or(&provider.default_model))
        .ok_or_else(|| format!("probe provider {provider_id} default model missing"))?;
    let responses = provider.responses.as_ref();
    Ok(V3ResponsesProviderTarget {
        provider_id: provider.id.clone(),
        provider_type: provider.provider_type.clone(),
        base_url: provider.base_url.clone(),
        canonical_model_id: model.id.clone(),
        wire_model: model.wire_name.clone(),
        compatibility_profile: provider.compatibility_profile.clone(),
        auth: V3ProviderAuthHandle {
            alias: auth.alias.clone(),
            secret,
        },
        responses_transport: responses
            .map(|value| value.transport)
            .unwrap_or_default(),
        websocket_v2_url: responses.and_then(|value| value.websocket_v2_url.clone()),
        provider_request_cleanup: provider.provider_request_cleanup.clone(),
        request_timeout_ms: provider.request_timeout_ms,
        initial_concurrency_budget: provider
            .concurrency
            .as_ref()
            .map(|value| value.max_in_flight)
            .unwrap_or(8),
    })
}

pub async fn probe_v3_provider_global_target(
    target: V3ResponsesProviderTarget,
) -> Result<(), String> {
    let provider_id = target.provider_id.clone();
    let body = serde_json::json!({
        "model": target.wire_model,
        "input": [{
            "role": "user",
            "content": [{"type": "input_text", "text": "routecodex health probe"}]
        }],
        "max_output_tokens": 1,
        "stream": false,
    });
    let wire = build_v3_provider_12_responses_wire_payload(
        format!("provider-global-probe-{provider_id}"),
        target,
        body,
    )
    .map_err(|error| error.to_string())?;
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire)
        .map_err(|error| error.to_string())?;
    let response = ReqwestResponsesTransport::default()
        .send(request)
        .await
        .map_err(|error| error.to_string())?;
    if !(200..=299).contains(&response.status()) {
        return Err(format!("provider global probe returned {}", response.status()));
    }
    Ok(())
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

fn configured_retry_budget_for_failure(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    provider_type: Option<&str>,
    model_id: Option<&str>,
    status: u16,
    error_type: Option<&str>,
    message: &str,
    default_budget: usize,
) -> usize {
    let Some(policy) = manifest.error.provider_error_action_policy.iter().find(|policy| {
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
                .any(|value| message.contains(value)))
    }) else {
        return default_budget;
    };
    policy
        .path
        .iter()
        .find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry { max_attempts, .. } => {
                Some(max_attempts.saturating_sub(1) as usize)
            }
            _ => None,
        })
        .unwrap_or(default_budget)
}

fn configured_health_policy_for_failure(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    provider_type: Option<&str>,
    model_id: Option<&str>,
    status: u16,
    error_type: Option<&str>,
    message: &str,
) -> Option<V3ProviderFailurePolicy> {
    let policy = manifest.error.provider_error_action_policy.iter().find(|policy| {
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
                .any(|value| message.contains(value)))
    })?;
    let threshold = policy
        .path
        .iter()
        .find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry { max_attempts, .. } => {
                Some((*max_attempts).max(1))
            }
            _ => None,
        })
        .unwrap_or(1);
    let cooldown_ms = policy.path.iter().find_map(|step| match step {
        V3ProviderDispositionStepManifest::Cooldown {
            duration_ms: Some(duration_ms),
            ..
        } => Some((*duration_ms).max(1)),
        _ => None,
    });
    let until_restart = policy.path.iter().any(|step| {
        matches!(
            step,
            V3ProviderDispositionStepManifest::Cooldown {
                until_restart: Some(true),
                ..
            }
        )
    });
    if cooldown_ms.is_none() && !until_restart {
        return None;
    }
    Some(V3ProviderFailurePolicy {
        failure_threshold: threshold,
        cooldown_ms: cooldown_ms.unwrap_or(1),
        until_restart,
    })
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
    session_availability: &dyn V3ProviderAvailabilityReader,
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
    global_subscription_store: V3ProviderGlobalSubscriptionHealthStore,
    action_gate: V3ProviderActionGate,
    default_same_provider_retries: usize,
}

pub(crate) struct V3SessionGlobalAvailabilityReader<'health> {
    session: V3ProviderSessionAvailabilityReader,
    global: &'health V3ProviderGlobalSubscriptionHealthStore,
}

impl V3ProviderAvailabilityReader for V3SessionGlobalAvailabilityReader<'_> {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self
            .session
            .availability(provider_id, auth_alias, model_id, now_ms);
        let global = self
            .global
            .availability(provider_id, auth_alias, model_id, now_ms);
        if !global.as_ref().is_ok_and(|availability| availability.available) {
            projection.available = false;
            projection
                .blocked_scopes
                .push("provider_global_subscription_failure".to_string());
        }
        projection
    }
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest(manifest),
            global_subscription_store: V3ProviderGlobalSubscriptionHealthStore::default(),
            action_gate: V3ProviderActionGate::process_shared(),
            default_same_provider_retries: V3RelayProviderFailureRetryPolicy::from_manifest(manifest)
                .same_candidate_retries,
        }
    }

    pub(crate) fn default_same_provider_retries(&self) -> usize {
        self.default_same_provider_retries
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
        let mut policy = V3ProviderGlobalSubscriptionPolicy::default();
        if let Some(cooldown_ms) = cooldown_ms {
            policy.cooldown_ms = cooldown_ms;
            policy.probe_interval_ms = cooldown_ms;
        }
        self.global_subscription_store
            .record_invalid_subscription_response(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                fingerprint,
                now_ms,
                &policy,
            )
    }

    pub(crate) fn global_subscription_store(
        &self,
    ) -> V3ProviderGlobalSubscriptionHealthStore {
        self.global_subscription_store.clone()
    }

    pub async fn run_due_global_subscription_probes<F, Fut>(
        &self,
        now_ms: u64,
        probe: F,
    ) -> Result<(), String>
    where
        F: Fn(String, Option<String>, Option<String>) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        let provider_keys = self
            .global_subscription_store
            .provider_keys_with_probe_due(now_ms)?;
        for (provider_id, auth_alias, model_id) in provider_keys {
            let Some(permit) = self
                .global_subscription_store
                .try_acquire_probe(
                    &provider_id,
                    auth_alias.as_deref(),
                    model_id.as_deref(),
                    now_ms,
                )?
            else {
                continue;
            };
            match probe(provider_id.clone(), auth_alias, model_id).await {
                Ok(()) => self
                    .global_subscription_store
                    .complete_probe_success(permit)?,
                Err(error) => {
                    self.global_subscription_store
                        .complete_probe_failure(permit)?;
                    return Err(format!("provider global probe failed for {provider_id}: {error}"));
                }
            }
        }
        Ok(())
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

    pub(crate) fn record_provider_failure_record_with_policy(
        &self,
        manifest: &V3Config05ManifestPublished,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        provider_type: Option<&str>,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        status: u16,
        error_type: Option<&str>,
        message: &str,
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
                configured_health_policy_for_failure(
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
        self.global_subscription_store
            .record_provider_success(
                provider_id,
                auth_alias,
                model_id,
                failure_session_scope,
            )?;
        self.action_gate
            .record_provider_success(&V3ProviderActionProviderScope::new(
                failure_session_scope,
                v3_relay_provider_candidate_key_parts(provider_id, auth_alias, model_id),
            )?)
    }

    pub(crate) fn try_acquire_cross_session_revive(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<bool, String> {
        self.store
            .try_acquire_cross_session_revive(
                failure_session_scope,
                provider_id,
                auth_alias,
                model_id,
                now_ms,
            )
            .map_err(|error| error.to_string())
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
    ) -> V3SessionGlobalAvailabilityReader<'_> {
        V3SessionGlobalAvailabilityReader {
            session: V3ProviderSessionAvailabilityReader::new(
                self.store.clone(),
                failure_session_scope.clone(),
            ),
            global: &self.global_subscription_store,
        }
    }
}

impl From<V3ProviderHealthStore> for V3ProviderFailureRuntimeHealth {
    fn from(store: V3ProviderHealthStore) -> Self {
        Self {
            store,
            global_subscription_store: V3ProviderGlobalSubscriptionHealthStore::default(),
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
        let mut projection = self.store
            .availability(provider_id, auth_alias, model_id, now_ms)
            ;
        let global_available = self
            .global_subscription_store
            .availability(provider_id, auth_alias, model_id, now_ms)
            .is_ok_and(|availability| availability.available);
        if !global_available {
            projection.available = false;
            projection
                .blocked_scopes
                .push("provider_global_subscription_failure".to_string());
        }
        projection
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
    let revive_admitted = context.provider_health.try_acquire_cross_session_revive(
        &context.failure_session_scope,
        &selected.candidate.provider_id,
        Some(&selected.candidate.auth_alias),
        Some(&selected.candidate.model_id),
        v3_relay_provider_policy_now_epoch_ms()?,
    )?;
    // 瞬态失败（SSE 流内/挂起）判定由错误处理中心按「阶段 + 类别」表达：
    // relay 侧在这里按同样的 stage/code 规则消费，直接驱动 health-neutral
    // 同 provider 重试（前 2 次静默，第 3 次失败一次回报再切），与入口脱耦。
    let transient = is_v3_retryable_transient_stage_code(
        source_stage,
        error_type.as_deref().unwrap_or_default(),
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
        context.manifest,
        &selected.candidate.provider_id,
        Some(&selected.candidate.provider_type),
        Some(&selected.candidate.model_id),
        status,
        error_type.as_deref(),
        &message,
        context.retry_policy.same_candidate_retries,
    );
    let retries_done = *state
        .same_candidate_retries
        .get(&candidate_key)
        .unwrap_or(&0);
    if transient && retries_done < V3_TRANSIENT_RETRY_BUDGET {
        // 前 2 次失败：同 provider 静默重试，不写 health（不冷却）、
        // 不经过 provider action gate（request-local witness，wait_ms=None）。
        state
            .same_candidate_retries
            .insert(candidate_key.clone(), retries_done + 1);
        state.trace.push("V3RelayTransientRetrySame");        let recovery = build_v3_transient_recovery_witness(
            &context.failure_session_scope,
            &candidate_key,
            error_type.as_deref().unwrap_or("provider_failure"),
        )?;
        let decision = build_v3_relay_provider_error_05_decision(
            &selected,
            source_stage,
            status,
            error_type.as_deref(),
            &message,
            0,
            false,
            true,
            Some(recovery),
        );
        return Ok(V3RelayProviderFailurePolicyResult {
            terminal_projection: terminal_projection_for(&decision, matched_policy),
            decision,
            retry_selected: Some(Box::new(selected.clone())),
            event: build_v3_relay_provider_failure_policy_event(
                V3RelayProviderFailurePolicyEventInput {
                    candidate: selected.candidate.clone(),
                    status,
                    error_type,
                    message: message.clone(),
                    health_record: build_v3_transient_failure_record(
                        &candidate_key,
                        (retries_done + 1) as u32,
                        Some(&message),
                    ),
                    action: "transient_retry_same",
                    next_provider_key: Some(candidate_key.clone()),
                    wait_ms: None,
                },
            ),
        });
    }
    let reason = (!message.trim().is_empty()).then_some(message.as_str());
    // 瞬态失败第 3 次尝试后：写 session 级短期绕行（30s），同 session 后续
    // 请求绕开该 provider，避免 health-neutral 导致反复命中；不触发 15 分钟
    // 冷却，超时自动恢复。
    if transient && retries_done >= V3_TRANSIENT_RETRY_BUDGET {
        context
            .provider_health
            .record_provider_transient_bypass_in_session(
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                Some(&message),
                v3_relay_provider_policy_now_epoch_ms()?,
            )
            .map_err(|error| error.to_string())?;
    }
    let is_request_local_compat_failure = source_stage == "ProviderReqCompat06ProviderCompat"
        || error_type.as_deref() == Some("provider_request_compat_error")
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
                context.manifest,
                &context.failure_session_scope,
                &selected.candidate.provider_id,
                Some(&selected.candidate.provider_type),
                Some(&selected.candidate.auth_alias),
                Some(&selected.candidate.model_id),
                reason,
                status,
                error_type.as_deref(),
                &message,
                v3_relay_provider_policy_now_epoch_ms()?,
            )
            .map_err(|error| error.to_string())?
    };
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    if error_type.as_deref() == Some("provider_transport_error") {
        // 连接层错误是 provider/baseurl 级故障：同 provider 的所有 key
        // 共用同一 baseURL，全部排除，避免 key2 失败切 key1 的 thrashing。
        if let Some(expanded) = context.captured_target_09 {
            for candidate in &expanded.candidates {
                if candidate.provider_id == selected.candidate.provider_id {
                    let key = v3_relay_provider_candidate_key(candidate);
                    excluded_with_failed.insert(key.clone());
                    state.failed_candidates.insert(key);
                }
            }
        }
    }
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
        } => {
            if revive_admitted {
                let recovery = V3Error05RecoveryAdmissionWitness::new(
                    context.failure_session_scope.clone(),
                    candidate_key.clone(),
                    error_type.as_deref().unwrap_or("provider_failure"),
                    1,
                )?;
                let decision = build_v3_relay_provider_error_05_decision(
                    &selected,
                    source_stage,
                    status,
                    error_type.as_deref(),
                    &message,
                    0,
                    false,
                    true,
                    Some(recovery),
                );
                state.trace.push("V3CrossSessionReviveRetry");
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
                            action: "retry_cross_session_revived_provider",
                            next_provider_key: Some(candidate_key),
                            wait_ms: None,
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
    if let Some(V3ProviderDispositionStepManifest::Project {
        status,
        public_code,
        ..
    }) = matched_policy.and_then(|policy| {
        policy.path.iter().rev().find_map(|step| match step {
            V3ProviderDispositionStepManifest::Project { .. } => Some(step),
            _ => None,
        })
    }) {
        // project step 只影响 Error06 显示层（status/public_code），
        // 不得反向影响 Error02-05 语义或 health。
        projected.status = *status;
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
                    .any(|value| message.contains(value)))
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

/// 瞬态失败（SSE 流内/挂起）同 provider 重试预算：与
/// `V3_TRANSIENT_PROVIDER_RETRY_BUDGET` 一致（=2 次重试，
/// 共 3 次尝试）；第 3 次尝试仍失败才回报一次并切 provider。语义属于
/// provider 内部失败重试，与入口（direct/relay/chat）无关。
#[cfg(test)]
mod tests;
