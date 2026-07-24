use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader, V3ProviderFailureRecord,
    V3ProviderHealthStore,
};
use routecodex_v3_target::{
    V3Target10ConcreteProviderSelected, V3TargetCandidate, V3TargetInterpreter,
};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

pub(crate) const V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES: usize = 3;
pub(crate) const V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET: usize =
    V3_PROVIDER_FAILURE_MAX_CONSECUTIVE_FAILURES - 1;
pub(crate) const V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct V3RelayProviderFailureRetryPolicy {
    pub(crate) same_candidate_retries: usize,
    pub(crate) retry_delay_ms: u64,
}

impl Default for V3RelayProviderFailureRetryPolicy {
    fn default() -> Self {
        Self {
            same_candidate_retries: V3_PROVIDER_FAILURE_SAME_PROVIDER_RETRY_BUDGET,
            retry_delay_ms: V3_PROVIDER_FAILURE_BACKOFF_DELAY_MS,
        }
    }
}

impl V3RelayProviderFailureRetryPolicy {
    pub(crate) fn default_floor_delay_ms_for_retry(&self, _retry_number: usize) -> u64 {
        self.retry_delay_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3RelayProviderFailureDecision {
    Reselect,
    RetrySame(Box<V3Target10ConcreteProviderSelected>),
    ProjectTerminal,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3RelayProviderFailurePolicyResult {
    pub(crate) decision: V3RelayProviderFailureDecision,
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
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest(manifest),
        }
    }

    pub(crate) fn record_provider_failure(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        self.record_provider_failure_record(provider_id, auth_alias, model_id, reason, now_ms)
            .map(|_| ())
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

    pub(crate) fn record_provider_success(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), String> {
        self.store
            .record_provider_success(provider_id, auth_alias, model_id, now_ms)
            .map_err(|error| error.to_string())
    }
}

impl From<V3ProviderHealthStore> for V3ProviderFailureRuntimeHealth {
    fn from(store: V3ProviderHealthStore) -> Self {
        Self { store }
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
    status: u16,
    error_type: Option<String>,
    message: String,
    state: &mut V3RelayProviderFailurePolicyState<'_>,
) -> Result<V3RelayProviderFailurePolicyResult, String> {
    let candidate_key = v3_relay_provider_candidate_key(&selected.candidate);
    let reason = (!message.trim().is_empty()).then_some(message.as_str());
    let health_record = context
        .provider_health
        .record_provider_failure_record(
            &selected.candidate.provider_id,
            Some(&selected.candidate.auth_alias),
            Some(&selected.candidate.model_id),
            reason,
            v3_relay_provider_policy_now_epoch_ms()?,
        )
        .map_err(|error| error.to_string())?;
    let mut excluded_with_failed = state.failed_candidates.clone();
    excluded_with_failed.insert(candidate_key.clone());
    if let Ok(alternative) = resolve_v3_relay_target(V3RelayProviderTargetResolutionInput {
        manifest: context.manifest,
        server_id: context.server_id,
        entry_kind: context.entry_kind,
        endpoint_path: context.endpoint_path,
        body: context.route_facts_body,
        request_local_excluded_candidates: &excluded_with_failed,
        provider_health: context.provider_health,
        now_ms: v3_relay_provider_policy_now_epoch_ms()?,
        deterministic_sample: context.deterministic_sample,
    }) {
        let alternative_key = v3_relay_provider_candidate_key(&alternative.candidate);
        if alternative_key != candidate_key || !alternative.default_floor_protected {
            let wait_ms = (health_record.failure_count > 1)
                .then_some(context.retry_policy.retry_delay_ms)
                .filter(|delay| *delay > 0);
            if let Some(delay_ms) = wait_ms {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            state.failed_candidates.insert(candidate_key);
            state.trace.push("V3TargetLocalReselected");
            return Ok(V3RelayProviderFailurePolicyResult {
                decision: V3RelayProviderFailureDecision::Reselect,
                event: build_v3_relay_provider_failure_policy_event(
                    V3RelayProviderFailurePolicyEventInput {
                        candidate: selected.candidate,
                        status,
                        error_type,
                        message,
                        health_record,
                        action: "switch_provider",
                        next_provider_key: Some(alternative_key),
                        wait_ms,
                    },
                ),
            });
        }
    }
    if selected.default_floor_protected || selected.candidate.default_pool_member {
        let retries_done = state
            .same_candidate_retries
            .entry(candidate_key.clone())
            .or_insert(0);
        if *retries_done >= context.retry_policy.same_candidate_retries {
            return Ok(V3RelayProviderFailurePolicyResult {
                decision: V3RelayProviderFailureDecision::ProjectTerminal,
                event: build_v3_relay_provider_failure_policy_event(
                    V3RelayProviderFailurePolicyEventInput {
                        candidate: selected.candidate,
                        status,
                        error_type,
                        message,
                        health_record,
                        action: "terminal_default_floor_exhausted",
                        next_provider_key: None,
                        wait_ms: None,
                    },
                ),
            });
        }
        *retries_done = retries_done.saturating_add(1);
        state.trace.push("V3DefaultFloorBackoffWait");
        let wait_ms = context
            .retry_policy
            .default_floor_delay_ms_for_retry(*retries_done);
        if wait_ms > 0 {
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        }
        return Ok(V3RelayProviderFailurePolicyResult {
            decision: V3RelayProviderFailureDecision::RetrySame(Box::new(selected.clone())),
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
        let wait_ms = (context.retry_policy.retry_delay_ms > 0)
            .then_some(context.retry_policy.retry_delay_ms);
        if let Some(delay_ms) = wait_ms {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        return Ok(V3RelayProviderFailurePolicyResult {
            decision: V3RelayProviderFailureDecision::RetrySame(Box::new(selected.clone())),
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
    state.failed_candidates.insert(candidate_key);
    Ok(V3RelayProviderFailurePolicyResult {
        decision: V3RelayProviderFailureDecision::Reselect,
        event: build_v3_relay_provider_failure_policy_event(
            V3RelayProviderFailurePolicyEventInput {
                candidate: selected.candidate,
                status,
                error_type,
                message,
                health_record,
                action: "exclude_candidate",
                next_provider_key: None,
                wait_ms: None,
            },
        ),
    })
}

pub(crate) fn resolve_v3_relay_target<R: V3ProviderAvailabilityReader + ?Sized>(
    input: V3RelayProviderTargetResolutionInput<'_, R>,
) -> Result<V3Target10ConcreteProviderSelected, String> {
    let facts = crate::build_v3_router_request_facts_for_entry(input.body, input.entry_kind);
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(input.manifest, input.server_id, input.endpoint_path, facts)
        .map_err(|error| format!("{error:?}"))?;
    let plan = router
        .resolve_route_pool_plan(input.manifest, classified)
        .map_err(|error| format!("{error:?}"))?;
    let hit = router
        .hit_opaque_target_plan_once(plan, input.deterministic_sample)
        .map_err(|error| format!("{error:?}"))?;
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    let expanded = target
        .expand_candidates(input.manifest, kind, input.deterministic_sample)
        .map_err(|error| error.to_string())?;
    target
        .select_available(
            expanded,
            &V3RelayExcludedAvailability {
                base: input.provider_health,
                excluded: input.request_local_excluded_candidates,
            },
            input.now_ms,
        )
        .map_err(|error| format!("{error:?}"))
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
