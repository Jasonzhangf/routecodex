mod manual;
mod persistence;
mod probe_schedule;
mod rate_limit;

use crate::global_cooldown::{V3ProviderCooldownFailureClass, V3ProviderRateLimitEpisode};
use crate::key_health::{
    V3ProviderHealthProbePermit, V3ProviderKeyHealthProjection, V3ProviderProbePurpose,
    V3ProviderSchedulingProjection, V3ProviderSchedulingReader,
};
use crate::probe_backoff::{
    long_probe_backoff_ms, probe_backoff_ms, provider_failure_cooldown_ms, MAX_PROBE_INTERVAL_MS,
};
use crate::provider_cooldown_probe::{
    provider_cooldown_probe_key_for_interface, resolve_provider_cooldown_probe_key_for_interface,
    V3ProviderCooldownProbeKey, V3ProviderCooldownProbeState,
    V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
};
pub use manual::V3_COOLDOWN_MANUAL_MAX_MS;
use persistence::{
    legacy_provider_cooldown_state_path_for_listener,
    legacy_provider_cooldown_state_path_for_manifest, listener_scoped_state_suffix,
    persist_cooldown_state, provider_cooldown_state_path_for_listener,
    provider_cooldown_state_path_for_manifest, start_provider_health_persistence,
    V3ProviderHealthPersistenceWriter,
};
use routecodex_v3_config::{V3Config05ManifestPublished, V3ProviderDispositionStepManifest};
use routecodex_v3_error::{
    V3ErrorActionScope, V3ProviderErrorFingerprint, V3ProviderFailureAction,
    V3ProviderFailureSessionScope, V3ProviderHealthScope, V3ProviderRecoveryKind,
    V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderAvailabilityProjection {
    pub provider_id: String,
    pub interface_id: String,
    pub auth_alias: Option<String>,
    pub model_id: Option<String>,
    pub available: bool,
    pub blocked_scopes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderQuotaState {
    pub scope_label: String,
    pub remaining: u64,
    pub reset_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum V3ProviderFailureCooldownScope {
    Session,
    ProviderKeyModel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailurePolicy {
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
    pub probe_interval_ms: u64,
    pub max_probe_interval_ms: Option<u64>,
    pub long_probe_backoff: bool,
    pub until_restart: bool,
    /// Advisory probe policy: probe outcome updates only the probe cadence and
    /// never blocks the identity. See `V3ProviderHealthAuthoringConfig`.
    pub advisory_probe: bool,
    pub cooldown_scope: V3ProviderFailureCooldownScope,
}

impl Default for V3ProviderFailurePolicy {
    fn default() -> Self {
        Self {
            failure_threshold: V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
            cooldown_ms: 5_000,
            probe_interval_ms: V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
            max_probe_interval_ms: None,
            long_probe_backoff: false,
            until_restart: false,
            advisory_probe: false,
            cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
        }
    }
}

pub const V3_PROVIDER_TRANSIENT_BYPASS_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailureRecord {
    pub scope_label: String,
    pub provider_key: String,
    pub state: String,
    pub failure_count: u32,
    pub cooldown_until_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_success_revision: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3ProviderGlobalSubscriptionPolicy {
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
    pub probe_interval_ms: u64,
}

impl Default for V3ProviderGlobalSubscriptionPolicy {
    fn default() -> Self {
        Self {
            failure_threshold: V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
            cooldown_ms: V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
            probe_interval_ms: V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderGlobalSubscriptionDecision {
    ProviderBlocked { blocked_until_ms: u64 },
    SessionFailure { count: u32 },
}

pub trait V3ProviderAvailabilityReader {
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        let _ = interface_id;
        self.availability(provider_id, auth_alias, model_id, now_ms)
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError>;
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderAllAvailable;

impl V3ProviderAvailabilityReader for V3ProviderAllAvailable {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        Ok(V3ProviderAvailabilityProjection {
            provider_id: provider_id.to_string(),
            interface_id: "default".to_string(),
            auth_alias: auth_alias.map(ToOwned::to_owned),
            model_id: model_id.map(ToOwned::to_owned),
            available: true,
            blocked_scopes: Vec::new(),
        })
    }
}

/// Typed identity of one business listener that owns provider health state.
///
/// The server passes this scope in; it never decides persistence. Provider
/// health owns the mapping from listener scope to state file so two listeners
/// can never share one mutable store or one persistence writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderHealthListenerScope {
    pub server_id: String,
    pub bind: String,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct V3ProviderHealthStore {
    pub(super) state: Arc<RwLock<V3ProviderHealthState>>,
    availability_generation: Arc<tokio::sync::watch::Sender<u64>>,
}

impl Default for V3ProviderHealthStore {
    fn default() -> Self {
        Self {
            state: Arc::new(RwLock::new(V3ProviderHealthState::default())),
            availability_generation: Arc::new(tokio::sync::watch::channel(0).0),
        }
    }
}

#[derive(Debug, Clone)]
pub struct V3ProviderAvailabilityRegistry {
    store: V3ProviderHealthStore,
}

#[derive(Debug, Clone)]
pub struct V3ProviderSessionAvailabilityReader {
    store: V3ProviderHealthStore,
    failure_session_scope: V3ProviderFailureSessionScope,
}

impl V3ProviderSessionAvailabilityReader {
    pub fn new(
        store: V3ProviderHealthStore,
        failure_session_scope: V3ProviderFailureSessionScope,
    ) -> Self {
        Self {
            store,
            failure_session_scope,
        }
    }
}

impl V3ProviderAvailabilityReader for V3ProviderSessionAvailabilityReader {
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        self.store.availability_for_session_for_interface(
            &self.failure_session_scope,
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
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        self.store.availability_for_session(
            &self.failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            now_ms,
        )
    }
}

impl V3ProviderAvailabilityRegistry {
    pub fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        Self {
            store: V3ProviderHealthStore::from_manifest(manifest),
        }
    }

    pub fn from_store(store: V3ProviderHealthStore) -> Self {
        Self { store }
    }
}

impl V3ProviderAvailabilityReader for V3ProviderAvailabilityRegistry {
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
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
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        self.store
            .availability(provider_id, auth_alias, model_id, now_ms)
    }
}

#[derive(Debug, Default)]
pub(super) struct V3ProviderHealthState {
    last_probe_acquisition_id: u64,
    persistence: Option<V3ProviderHealthPersistenceWriter>,
    configured_disabled: BTreeSet<String>,
    health_disabled: BTreeSet<String>,
    failure_policies: BTreeMap<String, V3ProviderFailurePolicy>,
    consecutive_failures: BTreeMap<V3ProviderFailureSessionKey, V3ProviderConsecutiveFailure>,
    cooldowns: BTreeMap<V3ProviderFailureSessionKey, V3ProviderCooldown>,
    auth_key_cooldowns: BTreeMap<V3ProviderCooldownProbeKey, V3ProviderCooldown>,
    provider_cooldown_probes: BTreeMap<V3ProviderCooldownProbeKey, V3ProviderCooldownProbeState>,
    /// Ephemeral physical ownership of a pre-cool observation probe.
    ///
    /// This is a control resource for the single probe slot only: it creates no
    /// cooldown entry, no schedule and no health classification, and it is
    /// never persisted.
    precool_observation_probes:
        BTreeMap<V3ProviderCooldownProbeKey, crate::key_health::V3ProbeAcquisitionId>,
    adaptive_history: BTreeMap<V3ProviderCooldownProbeKey, V3ProviderAdaptiveHistory>,
    quotas: BTreeMap<String, V3ProviderQuotaState>,
}

#[derive(Debug, Clone)]
struct V3ProviderAdaptiveHistory {
    rate_limit_episode: Option<V3ProviderRateLimitEpisode>,
    real_error_streak: u32,
    first_global_429_ms: Option<u64>,
    attempts: u32,
    failures: u32,
    recovery_ewma_ms: Option<u64>,
    probe_failure_count: u8,
    score_milli: u32,
    failure_streak: u32,
    /// Typed identity of the current `failure_streak`. Only consecutive
    /// failures with the same fingerprint extend the streak; a different
    /// fingerprint starts a new streak of 1.
    failure_fingerprint: Option<V3ProviderErrorFingerprint>,
    success_streak: u32,
    last_success_at_ms: Option<u64>,
    recovery_success_revision: u64,
    score_generation: u64,
}

impl Default for V3ProviderAdaptiveHistory {
    fn default() -> Self {
        Self {
            rate_limit_episode: None,
            real_error_streak: 0,
            first_global_429_ms: None,
            attempts: 0,
            failures: 0,
            recovery_ewma_ms: None,
            probe_failure_count: 0,
            score_milli: 100,
            failure_streak: 0,
            failure_fingerprint: None,
            success_streak: 0,
            last_success_at_ms: None,
            recovery_success_revision: 0,
            score_generation: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ProviderFailureSessionKey {
    server_id: String,
    routing_group: String,
    session_id: String,
    provider_id: String,
    interface_id: String,
    auth_alias: Option<String>,
    model_id: Option<String>,
    provider_runtime_identity: String,
}

#[derive(Debug, Clone)]
struct V3ProviderCooldown {
    reason: String,
    until_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct V3ProviderConsecutiveFailure {
    failure_count: u32,
    last_failure_at_ms: u64,
    reason: Option<String>,
    /// Typed identity of the counted streak. A failure with a different
    /// fingerprint starts a new consecutive-failure streak, so different
    /// recoverable errors never add up to one cooldown.
    fingerprint: Option<V3ProviderErrorFingerprint>,
}

#[derive(Debug, thiserror::Error)]
pub enum V3ProviderHealthError {
    #[error("provider probe acquisition identity exhausted")]
    ProbeAcquisitionExhausted,
    #[error("provider probe permit purpose does not match this completion path")]
    ProbePurposeMismatch,
    #[error("provider health state lock poisoned: {0}")]
    Poisoned(String),
    #[error("invalid manual cooldown request: {0}")]
    InvalidManualCooldown(String),
}

impl V3ProviderHealthError {
    /// 供无法命名本枚举的调用边界（listener / admin）区分操作员输入错误与
    /// 状态损坏：输入错误映射 400，其余映射 500。
    pub fn is_invalid_manual_cooldown(&self) -> bool {
        matches!(self, Self::InvalidManualCooldown(_))
    }
}

impl V3ProviderHealthStore {
    pub fn publish_availability_change(&self) {
        self.availability_generation.send_modify(|generation| {
            *generation = generation.wrapping_add(1);
        });
    }

    pub fn availability_generation(&self) -> u64 {
        *self.availability_generation.borrow()
    }

    pub async fn wait_for_availability_change(
        &self,
        observed_generation: u64,
    ) -> Result<u64, V3ProviderHealthError> {
        let mut receiver = self.availability_generation.subscribe();
        loop {
            let current = *receiver.borrow_and_update();
            if current != observed_generation {
                return Ok(current);
            }
            receiver
                .changed()
                .await
                .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        }
    }

    pub fn configured_failure_policy(
        &self,
        provider_id: &str,
    ) -> Result<V3ProviderFailurePolicy, String> {
        self.state
            .read()
            .map_err(|error| format!("provider health state poisoned: {error}"))
            .map(|state| {
                state
                    .failure_policies
                    .get(provider_id)
                    .copied()
                    .unwrap_or_default()
            })
    }

    pub fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
        let persistence_path = provider_cooldown_state_path_for_manifest(manifest);
        Self::from_manifest_internal(
            manifest,
            Some(persistence_path),
            Some(legacy_provider_cooldown_state_path_for_manifest(manifest)),
            None,
        )
    }

    /// Build the store owned by one business listener.
    ///
    /// The persistence owner selects a listener-scoped state file. A single
    /// listener keeps the historical path and legacy migration; a multi-listener
    /// manifest derives one file per listener and never imports the unowned
    /// aggregate record into every port.
    pub fn from_manifest_for_listener(
        manifest: &V3Config05ManifestPublished,
        listener: &V3ProviderHealthListenerScope,
    ) -> Self {
        let persistence_path = provider_cooldown_state_path_for_listener(manifest, listener);
        let legacy_persistence_path =
            legacy_provider_cooldown_state_path_for_listener(manifest, listener);
        let multi_listener = manifest
            .servers
            .values()
            .filter(|server| server.enabled)
            .count()
            > 1;
        let prune_scope_suffix = multi_listener.then(|| listener_scoped_state_suffix(listener));
        Self::from_manifest_internal(
            manifest,
            Some(persistence_path),
            legacy_persistence_path,
            prune_scope_suffix,
        )
    }

    pub fn from_manifest_without_persistence(manifest: &V3Config05ManifestPublished) -> Self {
        Self::from_manifest_internal(manifest, None, None, None)
    }

    pub fn from_manifest_with_persistence_path(
        manifest: &V3Config05ManifestPublished,
        persistence_path: PathBuf,
    ) -> Self {
        Self::from_manifest_internal(manifest, Some(persistence_path), None, None)
    }

    fn from_manifest_internal(
        manifest: &V3Config05ManifestPublished,
        persistence_path: Option<PathBuf>,
        legacy_persistence_path: Option<PathBuf>,
        prune_scope_suffix: Option<String>,
    ) -> Self {
        let configured_disabled = manifest
            .providers
            .values()
            .filter(|provider| !provider.enabled)
            .map(|provider| provider.id.clone())
            .collect();
        let mut health_disabled = BTreeSet::new();
        let mut failure_policies = BTreeMap::new();
        for provider in manifest.providers.values() {
            match provider.health.as_ref() {
                Some(health) if !health.enabled => {
                    health_disabled.insert(provider.id.clone());
                }
                Some(health) => {
                    failure_policies.insert(
                        provider.id.clone(),
                        V3ProviderFailurePolicy {
                            failure_threshold: health.failure_threshold.max(1),
                            cooldown_ms: health.cooldown_ms.max(1),
                            probe_interval_ms: V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
                            max_probe_interval_ms: health.probe_interval_ms,
                            long_probe_backoff: false,
                            until_restart: false,
                            advisory_probe: health.advisory_probe,
                            cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
                        },
                    );
                }
                None => {
                    failure_policies.insert(
                        provider.id.clone(),
                        default_failure_policy_from_manifest(manifest),
                    );
                }
            }
        }
        let mut state = V3ProviderHealthState {
            configured_disabled,
            health_disabled,
            failure_policies,
            ..V3ProviderHealthState::default()
        };
        if let Some((writer, persisted_entries, episodes)) = start_provider_health_persistence(
            manifest,
            persistence_path,
            legacy_persistence_path,
            prune_scope_suffix,
        ) {
            for (key, blocked_until_ms, next_probe_at_ms) in persisted_entries {
                if !matches!(
                    key.failure_class,
                    V3ProviderCooldownFailureClass::Semantic
                        | V3ProviderCooldownFailureClass::RateLimit
                        | V3ProviderCooldownFailureClass::ProbeLong
                        | V3ProviderCooldownFailureClass::ManualAuth
                ) || state.health_disabled.contains(&key.provider_id)
                    || state.configured_disabled.contains(&key.provider_id)
                {
                    continue;
                }
                let probe_key = provider_cooldown_probe_key_for_interface(
                    &key.provider_id,
                    &key.interface_id,
                    key.auth_alias.as_deref(),
                    key.model_id.as_deref(),
                );
                if key.failure_class == V3ProviderCooldownFailureClass::ManualAuth {
                    state.auth_key_cooldowns.insert(
                        probe_key.clone(),
                        V3ProviderCooldown {
                            reason: "manual".into(),
                            until_ms: Some(blocked_until_ms),
                        },
                    );
                } else if key.auth_alias.is_none() || key.model_id.is_none() {
                    // Retired automatic broad cooldowns cannot block exact identities.
                    continue;
                }
                state.provider_cooldown_probes.insert(
                    probe_key.clone(),
                    V3ProviderCooldownProbeState {
                        cooldown_cause: (key.failure_class
                            == V3ProviderCooldownFailureClass::RateLimit)
                            .then_some(V3ProviderCooldownFailureClass::RateLimit),
                        blocked_until_ms: Some(blocked_until_ms),
                        next_probe_at_ms: Some(next_probe_at_ms),
                        probe_interval_ms: V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
                        max_probe_interval_ms: state
                            .failure_policies
                            .get(&key.provider_id)
                            .and_then(|policy| policy.max_probe_interval_ms),
                        probe_failure_count: 0,
                        long_probe_backoff: key.failure_class
                            == V3ProviderCooldownFailureClass::ProbeLong,
                        observed_attempts: 0,
                        observed_failures: 0,
                        recovery_ewma_ms: None,
                        cooldown_started_at_ms: blocked_until_ms,
                        active_probe: None,
                        probe_model_id: probe_key.model_id.clone(),
                        rescue_probe_attempted: false,
                        advisory_probe: state
                            .failure_policies
                            .get(&key.provider_id)
                            .is_some_and(|policy| policy.advisory_probe),
                    },
                );
            }
            for (key, episode) in episodes {
                if !persistence::manifest_contains_cooldown_key(manifest, &key)
                    || state.health_disabled.contains(&key.provider_id)
                    || state.configured_disabled.contains(&key.provider_id)
                {
                    continue;
                }
                let probe_key = provider_cooldown_probe_key_for_interface(
                    &key.provider_id,
                    &key.interface_id,
                    key.auth_alias.as_deref(),
                    key.model_id.as_deref(),
                );
                state
                    .adaptive_history
                    .entry(probe_key)
                    .or_default()
                    .rate_limit_episode = Some(episode);
            }
            state.persistence = Some(writer);
        }
        Self {
            state: Arc::new(RwLock::new(state)),
            availability_generation: Arc::new(tokio::sync::watch::channel(0).0),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_provider_failure_in_session_with_policy_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        failure_fingerprint: Option<V3ProviderErrorFingerprint>,
        now_ms: u64,
        policy_override: Option<V3ProviderFailurePolicy>,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        let provider_key = provider_key_label(provider_id, interface_id, auth_alias, model_id);
        let key = provider_failure_session_key_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        let scope_label = provider_failure_session_scope_label(&key);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if state.health_disabled.contains(provider_id) {
            return Ok(V3ProviderFailureRecord {
                scope_label,
                provider_key,
                state: "health_disabled".to_string(),
                failure_count: 0,
                cooldown_until_ms: None,
                recovery_success_revision: None,
                reason: reason.map(str::to_string),
            });
        }
        let mut policy = policy_override.unwrap_or_else(|| {
            state
                .failure_policies
                .get(provider_id)
                .copied()
                .unwrap_or_default()
        });
        if let Some(configured_max_probe_interval_ms) = state
            .failure_policies
            .get(provider_id)
            .and_then(|configured| configured.max_probe_interval_ms)
        {
            policy.max_probe_interval_ms = Some(
                policy
                    .max_probe_interval_ms
                    .map_or(configured_max_probe_interval_ms, |maximum| {
                        maximum.min(configured_max_probe_interval_ms)
                    }),
            );
        }
        if policy.cooldown_scope == V3ProviderFailureCooldownScope::ProviderKeyModel {
            if let (Some(alias), Some(model)) = (auth_alias, model_id) {
                drop(state);
                let mut action = V3ProviderFailureAction::recoverable("provider_failure");
                action.failure_threshold = policy.failure_threshold;
                action.failure_fingerprint = failure_fingerprint;
                action.cooldown_ms = policy.cooldown_ms;
                action.long_probe_backoff = policy.long_probe_backoff;
                action.advisory_probe = policy.advisory_probe;
                let projection = self
                    .record_provider_failure_action_for_interface(
                        provider_id,
                        interface_id,
                        alias,
                        model,
                        &action,
                        now_ms,
                    )
                    .map_err(V3ProviderHealthError::Poisoned)?;
                return Ok(V3ProviderFailureRecord {
                    scope_label,
                    provider_key,
                    state: if projection.cooldown {
                        "cooldown"
                    } else {
                        "healthy"
                    }
                    .into(),
                    failure_count: projection.failure_streak,
                    cooldown_until_ms: projection.cooldown_until_ms,
                    recovery_success_revision: Some(projection.recovery_success_revision),
                    reason: reason.map(str::to_string),
                });
            }
        }
        if state
            .cooldowns
            .get(&key)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until > now_ms))
        {
            let failure_count = state
                .consecutive_failures
                .get(&key)
                .map_or(0, |failure| failure.failure_count);
            let cooldown_until_ms = state
                .cooldowns
                .get(&key)
                .and_then(|cooldown| cooldown.until_ms);
            return Ok(V3ProviderFailureRecord {
                scope_label,
                provider_key,
                state: "cooldown".to_string(),
                failure_count,
                cooldown_until_ms,
                recovery_success_revision: None,
                reason: reason.map(str::to_string),
            });
        }
        if state
            .cooldowns
            .get(&key)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until <= now_ms))
        {
            state.cooldowns.remove(&key);
            state.consecutive_failures.remove(&key);
        }
        let failure =
            state
                .consecutive_failures
                .entry(key.clone())
                .or_insert(V3ProviderConsecutiveFailure {
                    failure_count: 0,
                    last_failure_at_ms: now_ms,
                    reason: None,
                    fingerprint: None,
                });
        if failure.fingerprint != failure_fingerprint {
            failure.failure_count = 0;
        }
        failure.fingerprint = failure_fingerprint;
        failure.failure_count = failure.failure_count.saturating_add(1);
        failure.last_failure_at_ms = now_ms;
        if let Some(reason) = reason.filter(|value| !value.trim().is_empty()) {
            failure.reason = Some(reason.to_string());
        }
        let failure_count = failure.failure_count;
        let record_reason = failure.reason.clone();
        let mut cooldown_until_ms = None;
        let mut record_state = "healthy".to_string();
        // 失败计数绑定完整 session + provider key；不同 session、不同 key
        // 独立计数，不能互相污染。
        if failure_count >= policy.failure_threshold {
            cooldown_until_ms = (!policy.until_restart)
                .then(|| now_ms.saturating_add(provider_failure_cooldown_ms(failure_count, 0, 0)));
            record_state = "cooldown".to_string();
            let cooldown = V3ProviderCooldown {
                reason: record_reason
                    .clone()
                    .unwrap_or_else(|| "provider_consecutive_failures".to_string()),
                until_ms: cooldown_until_ms,
            };
            state.cooldowns.insert(key.clone(), cooldown);
        }
        Ok(V3ProviderFailureRecord {
            scope_label,
            provider_key,
            state: record_state,
            failure_count,
            cooldown_until_ms,
            recovery_success_revision: None,
            reason: record_reason,
        })
    }

    /// session 级短期绕行（瞬态失败耗尽 3 次尝试后调用）：在当前 session
    /// scope 内把 provider 短时（`V3_PROVIDER_TRANSIENT_BYPASS_MS`）标记为
    /// 不可用，供 availability 查询绕开；不累计 consecutive_failures、
    /// 不触发 15 分钟 cooldown（health-neutral），超时由
    /// `remove_expired_session_state` 自动清理恢复。若已存在更长的真实
    /// cooldown，保持不动（真实冷却优先）。
    pub fn record_provider_transient_bypass_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        self.record_provider_transient_bypass_in_session_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            reason,
            now_ms,
        )
    }

    pub fn record_provider_transient_bypass_in_session_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        let provider_key = provider_key_label(provider_id, interface_id, auth_alias, model_id);
        let key = provider_failure_session_key_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        let scope_label = provider_failure_session_scope_label(&key);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if state.health_disabled.contains(provider_id) {
            return Ok(V3ProviderFailureRecord {
                scope_label,
                provider_key,
                state: "health_disabled".to_string(),
                failure_count: 0,
                cooldown_until_ms: None,
                recovery_success_revision: None,
                reason: reason.map(str::to_string),
            });
        }
        if let Some(cooldown) = state
            .cooldowns
            .get(&key)
            .filter(|cooldown| cooldown.until_ms.is_none_or(|until| until > now_ms))
        {
            // 已有未过期冷却（真实 cooldown 或更早的 bypass）：保持现状。
            let failure_count = state
                .consecutive_failures
                .get(&key)
                .map_or(0, |failure| failure.failure_count);
            return Ok(V3ProviderFailureRecord {
                scope_label,
                provider_key,
                state: "cooldown".to_string(),
                failure_count,
                cooldown_until_ms: cooldown.until_ms,
                recovery_success_revision: None,
                reason: reason.map(str::to_string),
            });
        }
        let until_ms = now_ms.saturating_add(V3_PROVIDER_TRANSIENT_BYPASS_MS);
        state.cooldowns.insert(
            key,
            V3ProviderCooldown {
                reason: reason
                    .map(str::to_string)
                    .unwrap_or_else(|| "provider_transient_exhausted".to_string()),
                until_ms: Some(until_ms),
            },
        );
        Ok(V3ProviderFailureRecord {
            scope_label,
            provider_key,
            state: "transient_bypass".to_string(),
            failure_count: 0,
            cooldown_until_ms: Some(until_ms),
            recovery_success_revision: None,
            reason: reason.map(str::to_string),
        })
    }

    /// A real success restores this provider identity across sessions.
    pub fn record_provider_success_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.record_provider_success_in_session_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            _now_ms,
        )
    }

    pub fn record_provider_success_in_session_for_interface(
        &self,
        _failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let provider_runtime_identity =
            provider_key_label(provider_id, interface_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        state.cooldowns.retain(|session_key, _| {
            session_key.provider_runtime_identity != provider_runtime_identity
        });
        state.consecutive_failures.retain(|session_key, _| {
            session_key.provider_runtime_identity != provider_runtime_identity
        });
        let matching_sessions: Vec<_> = state
            .adaptive_history
            .keys()
            .filter(|candidate| {
                matches!(
                    &candidate.scope,
                    crate::provider_cooldown_probe::V3ProviderCooldownHealthScope::Session { .. }
                ) && candidate.provider_id == provider_id
                    && candidate.interface_id == interface_id
                    && candidate.auth_alias.as_deref() == auth_alias
                    && candidate.model_id.as_deref() == model_id
            })
            .cloned()
            .collect();
        for session_key in matching_sessions {
            rate_limit::reset_on_business_success(&mut state, &session_key, _now_ms);
            if let Some(history) = state.adaptive_history.get_mut(&session_key) {
                history.score_generation = history.score_generation.saturating_add(1);
            }
            if state
                .provider_cooldown_probes
                .get(&session_key)
                .is_some_and(|probe| {
                    probe.cooldown_cause == Some(V3ProviderCooldownFailureClass::RateLimit)
                })
            {
                state.provider_cooldown_probes.remove(&session_key);
            }
        }
        let model_key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        record_adaptive_success(&mut state, &model_key, _now_ms);
        // Identity-scoped policies are handled by their existing health owner.
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(())
    }

    /// post-commit SSE 流失败（流已开始却中断/malformed）直接写 provider 级
    /// 冷却：这是强故障信号（响应已投影却断流），不等 session 计数达阈值。
    /// 冷却到期后由后台 probe 复活；不累计 session 计数（流已开始，session
    /// 计数语义由调用方另行处理）。
    pub fn record_provider_stream_failure_in_provider_scope(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        // 冷却原因由调用方的 failure record 承载；这里只负责 provider 级
        // 冷却与探针状态，不把原因写进共享探针状态。
        _reason: &str,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.record_provider_stream_failure_in_provider_scope_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            _reason,
            now_ms,
        )
    }

    pub fn record_provider_stream_failure_in_provider_scope_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _reason: &str,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if state.health_disabled.contains(provider_id) {
            return Ok(());
        }
        let policy = state
            .failure_policies
            .get(provider_id)
            .copied()
            .unwrap_or_default();
        let history_key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        let (failure_streak, attempts, failures) = {
            let history = state.adaptive_history.entry(history_key).or_default();
            history.attempts = history.attempts.saturating_add(1);
            history.failures = history.failures.saturating_add(1);
            history.failure_streak = history.failure_streak.saturating_add(1);
            (history.failure_streak, history.attempts, history.failures)
        };
        let cooldown_until_ms = (!policy.until_restart).then(|| {
            now_ms.saturating_add(provider_failure_cooldown_ms(
                failure_streak,
                attempts,
                failures,
            ))
        });
        if let Some(until_ms) = cooldown_until_ms {
            upsert_provider_cooldown_probe(
                &mut state,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                now_ms,
                until_ms,
            );
        }
        persist_cooldown_state(state);
        Ok(())
    }

    /// provider 级冷却（跨 session 共享）的独立探针状态：冷却期内与
    /// 待探期内 provider 不可达业务请求；冷却到期不自动恢复，后台探针
    /// 通过才清除并恢复可达。与 `V3ProviderGlobalSubscriptionHealthStore`
    /// 物理隔离，订阅探针状态不得混入 provider 级冷却决策。
    pub fn record_provider_cooldown_failure(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: &str,
        now_ms: u64,
        cooldown_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.record_provider_cooldown_failure_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            reason,
            now_ms,
            cooldown_ms,
        )
    }

    pub fn record_provider_cooldown_failure_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: &str,
        now_ms: u64,
        cooldown_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let blocked_until_ms = now_ms.saturating_add(cooldown_ms.max(1));
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if state.health_disabled.contains(provider_id) {
            return Ok(());
        }
        upsert_provider_cooldown_probe(
            &mut state,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
            blocked_until_ms,
        );
        persist_cooldown_state(state);
        let _ = reason;
        Ok(())
    }

    /// Acquire the only scheduled provider-health probe permit.
    pub fn acquire_provider_cooldown_probe(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_probe_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
        )
    }

    pub fn acquire_provider_cooldown_probe_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_probe_at_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            None,
            false,
        )
    }

    pub fn acquire_provider_cooldown_rescue_probe(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_rescue_probe_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
        )
    }

    pub fn acquire_provider_cooldown_rescue_probe_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<Option<V3ProviderHealthProbePermit>, V3ProviderHealthError> {
        self.acquire_provider_cooldown_rescue_probe_impl_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        )
    }

    /// probe 通过：清除 provider 级冷却，provider 复活（业务路由恢复可达）。
    pub fn complete_provider_cooldown_probe_success(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_success_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
        )
    }

    pub fn complete_provider_cooldown_probe_success_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_success_at_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            0,
        )
    }

    pub fn complete_provider_cooldown_probe_success_at(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_success_at_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            now_ms,
        )
    }

    pub fn complete_provider_cooldown_probe_success_at_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_success_impl(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
            None,
        )
        .map(|_| ())
    }

    pub fn complete_provider_cooldown_probe_success_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_success_if_current_with_permit(permit, now_ms)
            .map(|_| ())
    }

    /// Return the qualified recovery decision from the same locked transition.
    /// Runtime must not infer it from a later availability projection.
    pub fn complete_provider_cooldown_probe_success_if_current_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        now_ms: u64,
    ) -> Result<bool, V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_success_impl(
            permit.provider_id(),
            permit.interface_id(),
            permit.auth_alias(),
            permit.model_id(),
            now_ms,
            Some(permit),
        )
    }

    /// Account for one real probe error under the same current permit that
    /// owns the recovery schedule. `None` status is a real transport failure.
    pub fn complete_provider_cooldown_probe_real_failure_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        status: Option<u16>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_failure_impl(
            permit.provider_id(),
            permit.interface_id(),
            permit.auth_alias(),
            permit.model_id(),
            now_ms,
            Some(permit),
            Some(status),
        )
    }

    fn complete_provider_cooldown_probe_success_impl(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
        permit: Option<&V3ProviderHealthProbePermit>,
    ) -> Result<bool, V3ProviderHealthError> {
        if permit.is_some_and(|permit| permit.purpose() != V3ProviderProbePurpose::CooldownRecovery)
        {
            // A pre-cool observation must close through its own qualified path:
            // this cooldown completion would fabricate recovery/score.
            return Err(V3ProviderHealthError::ProbePurposeMismatch);
        }
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if let Some(permit) = permit {
            if !probe_schedule::release_probe_acquisition(&mut state, permit) {
                return Ok(false);
            }
        }
        let key = permit
            .map(V3ProviderHealthProbePermit::cooldown_key)
            .unwrap_or_else(|| {
                resolve_provider_cooldown_probe_key_for_interface(
                    &state.provider_cooldown_probes,
                    provider_id,
                    interface_id,
                    auth_alias,
                    model_id,
                )
            });
        let recovered = complete_provider_probe_success_at_generation(
            &mut state,
            &key,
            now_ms,
            permit.map(V3ProviderHealthProbePermit::expected_generation),
        )
        .map_err(V3ProviderHealthError::Poisoned)?;
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(recovered)
    }

    /// probe 失败：保持冷却，推后下一次探针。
    pub fn complete_provider_cooldown_probe_failure(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_failure_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            now_ms,
        )
    }

    pub fn complete_provider_cooldown_probe_failure_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_failure_impl(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
            None,
            None,
        )
    }

    pub fn complete_provider_cooldown_probe_failure_with_permit(
        &self,
        permit: &V3ProviderHealthProbePermit,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        self.complete_provider_cooldown_probe_failure_impl(
            permit.provider_id(),
            permit.interface_id(),
            permit.auth_alias(),
            permit.model_id(),
            now_ms,
            Some(permit),
            None,
        )
    }

    fn complete_provider_cooldown_probe_failure_impl(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
        permit: Option<&V3ProviderHealthProbePermit>,
        real_failure_status: Option<Option<u16>>,
    ) -> Result<(), V3ProviderHealthError> {
        if permit.is_some_and(|permit| permit.purpose() != V3ProviderProbePurpose::CooldownRecovery)
        {
            // A pre-cool observation failure must stay with Runtime's pending
            // action; this path would reschedule a non-existent cooldown.
            return Err(V3ProviderHealthError::ProbePurposeMismatch);
        }
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if let Some(permit) = permit {
            if !probe_schedule::release_probe_acquisition(&mut state, permit) {
                return Ok(());
            }
        }
        let key = permit
            .map(V3ProviderHealthProbePermit::cooldown_key)
            .unwrap_or_else(|| {
                resolve_provider_cooldown_probe_key_for_interface(
                    &state.provider_cooldown_probes,
                    provider_id,
                    interface_id,
                    auth_alias,
                    model_id,
                )
            });
        let Some(existing_probe) = state.provider_cooldown_probes.get(&key).cloned() else {
            return Ok(());
        };
        let max_probe_interval_ms = existing_probe.max_probe_interval_ms;
        let long_probe_backoff = existing_probe.long_probe_backoff;
        // An advisory probe never accumulates a health ladder. Its failure keeps
        // the probe at the base cadence so recovery is retried at a fixed rate
        // instead of escalating to 30m steps while the upstream is down.
        let advisory_probe = existing_probe.advisory_probe;
        let current_generation = state
            .adaptive_history
            .get(&key)
            .map_or(0, |history| history.score_generation);
        if let Some(expected_generation) =
            permit.map(V3ProviderHealthProbePermit::expected_generation)
        {
            if expected_generation != current_generation {
                persist_cooldown_state(state);
                self.publish_availability_change();
                return Ok(());
            }
        }
        if let (Some(status), Some(auth_alias), Some(model_id)) =
            (real_failure_status, auth_alias, model_id)
        {
            if !state.health_disabled.contains(provider_id)
                && status.is_none_or(|value| {
                    (100..=599).contains(&value) && !(200..300).contains(&value)
                })
            {
                let identity = provider_cooldown_probe_key_for_interface(
                    provider_id,
                    interface_id,
                    Some(auth_alias),
                    Some(model_id),
                );
                Self::record_real_failure_locked(&mut state, &identity, status, now_ms);
            }
        }
        if existing_probe.cooldown_cause == Some(V3ProviderCooldownFailureClass::RateLimit) {
            let probe = state
                .provider_cooldown_probes
                .get_mut(&key)
                .expect("probe was checked");
            if probe.next_probe_at_ms.is_none_or(|next| next <= now_ms) {
                let midnight = (now_ms.saturating_add(8 * 3_600_000) / 86_400_000)
                    .saturating_add(1)
                    .saturating_mul(86_400_000)
                    .saturating_sub(8 * 3_600_000);
                probe.next_probe_at_ms =
                    Some(now_ms.saturating_add(probe.probe_interval_ms).min(midnight));
            }
            persist_cooldown_state(state);
            self.publish_availability_change();
            return Ok(());
        }
        let next_probe_failure_count = if advisory_probe {
            existing_probe.probe_failure_count
        } else {
            existing_probe.probe_failure_count.saturating_add(1)
        };
        // A cooldown probe is control-plane recovery traffic, not a provider
        // transport attempt. Keep its failure counter on the probe state and
        // preserve the transport history used by candidate scheduling.
        let (observed_attempts, observed_failures) = state
            .adaptive_history
            .get(&key)
            .map(|history| (history.attempts, history.failures))
            .unwrap_or_default();
        // The ladder stays observable; a configured fast-recovery provider
        // only caps how long any step may wait.
        let ladder_interval = if long_probe_backoff {
            long_probe_backoff_ms(next_probe_failure_count)
        } else {
            probe_backoff_ms(next_probe_failure_count)
        };
        let next_interval = max_probe_interval_ms
            .map(|maximum| ladder_interval.min(maximum))
            .unwrap_or(ladder_interval);
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(&key) else {
            return Ok(());
        };
        probe_state.active_probe = None;
        probe_state.probe_failure_count = next_probe_failure_count;
        probe_state.observed_attempts = observed_attempts;
        probe_state.observed_failures = observed_failures;
        probe_state.probe_interval_ms = next_interval;
        probe_state.next_probe_at_ms = Some(now_ms.saturating_add(probe_state.probe_interval_ms));
        // Keep the rescue generation single-flight after a failed rescue. The
        // scheduled probe cadence above is the recovery path; allowing every
        // exhausted request to re-open the same failed generation creates a
        // probe storm and keeps the session in select/exhaust churn.
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(())
    }

    pub fn record_provider_failure_action(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        self.record_provider_failure_action_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            action,
            now_ms,
        )
    }

    /// Record one typed upstream HTTP or transport failure for the complete identity.
    /// This is independent of the session-local recovery observation.
    pub fn record_real_provider_failure_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        status: Option<u16>,
        now_ms: u64,
    ) -> Result<(), String> {
        if status
            .is_some_and(|status| !(100..=599).contains(&status) || (200..300).contains(&status))
        {
            return Ok(());
        }
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let mut state = self.state.write().map_err(|error| error.to_string())?;
        if state.health_disabled.contains(provider_id) {
            return Ok(());
        }
        Self::record_real_failure_locked(&mut state, &key, status, now_ms);
        drop(state);
        self.publish_availability_change();
        Ok(())
    }

    fn record_real_failure_locked(
        state: &mut V3ProviderHealthState,
        key: &V3ProviderCooldownProbeKey,
        status: Option<u16>,
        now_ms: u64,
    ) {
        let history = state.adaptive_history.entry(key.clone()).or_default();
        history.real_error_streak = history.real_error_streak.saturating_add(1);
        history.score_generation = history.score_generation.saturating_add(1);
        if status == Some(429) {
            history.first_global_429_ms.get_or_insert(now_ms);
        }
        let should_cool = history.real_error_streak >= 10
            && (status != Some(429)
                || history
                    .first_global_429_ms
                    .is_some_and(|first| now_ms.saturating_sub(first) > 120_000));
        if should_cool {
            let interval = V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS;
            upsert_provider_cooldown_probe_with_interval(
                state,
                &key.provider_id,
                &key.interface_id,
                key.auth_alias.as_deref(),
                key.model_id.as_deref(),
                now_ms,
                now_ms.saturating_add(interval),
                interval,
                false,
                false,
            );
        }
    }

    pub fn record_provider_failure_action_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        self.record_provider_failure_action_impl(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            action,
            now_ms,
            false,
        )?
        .ok_or_else(|| "unconditional provider failure observation was not applied".into())
    }

    /// A late business failure joins and updates the existing owner atomically.
    /// If recovery already won, the caller must start a fresh observation.
    pub fn record_provider_failure_action_if_cooled_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<Option<V3ProviderKeyHealthProjection>, String> {
        self.record_provider_failure_action_impl(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            action,
            now_ms,
            true,
        )
    }

    fn record_provider_failure_action_impl(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        action: &V3ProviderFailureAction,
        now_ms: u64,
        only_if_cooled: bool,
    ) -> Result<Option<V3ProviderKeyHealthProjection>, String> {
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider health state poisoned: {error}"))?;
        if only_if_cooled
            && !state
                .provider_cooldown_probes
                .get(&key)
                .is_some_and(|probe| {
                    probe.active_probe.is_some()
                        || probe.blocked_until_ms.is_some()
                        || probe.next_probe_at_ms.is_some()
                })
        {
            return Ok(None);
        }
        if action
            .failure_fingerprint
            .as_ref()
            .is_some_and(|fingerprint| fingerprint.http_status == 429)
            && !state.health_disabled.contains(provider_id)
        {
            rate_limit::observe_rate_limit(&mut state, &key, now_ms, true);
            let projection = key_health_projection(&state, &key, now_ms);
            persist_cooldown_state(state);
            self.publish_availability_change();
            return Ok(Some(projection));
        }
        let interrupted_rate_limit_streak = action
            .failure_fingerprint
            .as_ref()
            .is_some_and(|fingerprint| fingerprint.http_status != 429)
            && state
                .adaptive_history
                .get_mut(&key)
                .and_then(|history| history.rate_limit_episode.as_mut())
                .is_some_and(|episode| {
                    let changed = episode.consecutive_429 != 0;
                    episode.consecutive_429 = 0;
                    changed
                });
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::NotProviderHealth
                | V3ProviderRecoveryKind::HealthNeutralTransient
        ) {
            let projection = key_health_projection(&state, &key, now_ms);
            if interrupted_rate_limit_streak {
                persist_cooldown_state(state);
            }
            return Ok(Some(projection));
        }
        if state.health_disabled.contains(provider_id) {
            return Ok(Some(key_health_projection(&state, &key, now_ms)));
        }
        let history = state.adaptive_history.entry(key.clone()).or_default();
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
                | V3ProviderRecoveryKind::RecoverableCounted
        ) {
            record_health_delta(history, action.score_delta_milli);
        }
        history.success_streak = 0;
        match action.recovery {
            V3ProviderRecoveryKind::RecoverableCounted
                if action.scope == V3ProviderHealthScope::GlobalProviderKey =>
            {
                // 连续失败必须同源：只有同一个 typed fingerprint 的失败才累计
                // streak，500/502 这类不同错误不会凑够阈值而误冷却 provider。
                // 没有上游状态的失败已由分类器落到失败类别身份，不比较 class_code
                // 之外的隐式状态。真实 HTTP 429 已由专用 rate-limit episode 处理。
                history.failure_streak =
                    if history.failure_fingerprint == action.failure_fingerprint {
                        history.failure_streak.saturating_add(1)
                    } else {
                        1
                    };
                history.failure_fingerprint = action.failure_fingerprint.clone();
            }
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown => {
                history.failure_streak = history.failure_streak.saturating_add(1);
                history.failure_fingerprint = action.failure_fingerprint.clone();
            }
            _ => {}
        }
        if matches!(
            action.recovery,
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
                | V3ProviderRecoveryKind::RecoverableCounted
        ) {
            history.attempts = history.attempts.saturating_add(1);
            history.failures = history.failures.saturating_add(1);
            history.score_generation = history.score_generation.saturating_add(1);
            // Observation bookkeeping is not a new business failure. Only
            // the real-attempt counter can commit identity-wide cooldown.
        }
        let projection = key_health_projection(&state, &key, now_ms);
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(Some(projection))
    }

    pub fn record_provider_key_success(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        self.record_provider_key_success_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            now_ms,
        )
    }

    pub fn record_provider_key_success_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let mut state = self
            .state
            .write()
            .map_err(|error| format!("provider health state poisoned: {error}"))?;
        // 全局复活（bug 61863a0）：冷却中的 key 收到真实成功调用时立即解除
        // 全局冷却并清理探针状态，其余 session 不必等探针周期；探针成功
        // （complete_probe_success）仍是无人成功调用时的恢复路径。
        let business_may_restore = rate_limit::reset_on_business_success(&mut state, &key, now_ms);
        if business_may_restore
            && state
                .provider_cooldown_probes
                .get(&key)
                .is_some_and(|probe| {
                    probe.cooldown_cause == Some(V3ProviderCooldownFailureClass::RateLimit)
                })
            && !state.auth_key_cooldowns.contains_key(&key)
        {
            complete_provider_probe_success_at_generation(&mut state, &key, now_ms, None)
                .map_err(|error| format!("provider health state poisoned: {error}"))?;
        } else {
            // Matching business success releases this exact recoverable identity.
            // Preserve the normal +1 score accounting and explicit auth holds.
            if business_may_restore && !state.auth_key_cooldowns.contains_key(&key) {
                state.provider_cooldown_probes.remove(&key);
            }
            // Healthy identities retain their normal score increment. Explicit
            // auth holds stay owned by the operator/probe control path.
            let history = state.adaptive_history.entry(key.clone()).or_default();
            history.attempts = 0;
            history.failures = 0;
            record_health_delta(history, 1);
            history.failure_streak = 0;
            history.real_error_streak = 0;
            history.first_global_429_ms = None;
            history.failure_fingerprint = None;
            history.success_streak = history.success_streak.saturating_add(1);
            history.last_success_at_ms = Some(now_ms);
            history.recovery_success_revision = history.recovery_success_revision.saturating_add(1);
            history.score_generation = history.score_generation.saturating_add(1);
        }
        let projection = key_health_projection(&state, &key, now_ms);
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(projection)
    }

    /// Returns the current listener-local revision of real successful responses
    /// or accepted probes for one exact provider identity. Notifications and
    /// failures do not advance this value.
    pub fn recovery_success_revision_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
    ) -> Result<u64, String> {
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let state = self.state.read().map_err(|error| error.to_string())?;
        Ok(state
            .adaptive_history
            .get(&key)
            .map_or(0, |history| history.recovery_success_revision))
    }

    pub fn complete_probe_success(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        self.complete_probe_success_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            now_ms,
        )
    }

    pub fn complete_probe_success_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        self.complete_provider_cooldown_probe_success_at_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
            now_ms,
        )
        .map_err(|error| error.to_string())?;
        let state = self
            .state
            .read()
            .map_err(|error| format!("provider health state poisoned: {error}"))?;
        Ok(key_health_projection(&state, &key, now_ms))
    }

    pub fn complete_probe_failure(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
        _cooldown_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        self.complete_probe_failure_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            now_ms,
            _cooldown_ms,
        )
    }

    pub fn complete_probe_failure_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
        _cooldown_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        self.complete_provider_cooldown_probe_failure_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
            now_ms,
        )
        .map_err(|error| error.to_string())?;
        let state = self
            .state
            .read()
            .map_err(|error| format!("provider health state poisoned: {error}"))?;
        Ok(key_health_projection(&state, &key, now_ms))
    }

    pub fn scheduling_projection_for_key(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        _now_ms: u64,
    ) -> Result<V3ProviderSchedulingProjection, V3ProviderHealthError> {
        self.scheduling_projection_for_key_with_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            priority,
            base_weight,
            _now_ms,
        )
    }

    pub fn scheduling_projection_for_key_with_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        _now_ms: u64,
    ) -> Result<V3ProviderSchedulingProjection, V3ProviderHealthError> {
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            Some(model_id),
        );
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let (score_milli, score_generation) = state
            .adaptive_history
            .get(&key)
            .map(|history| (history.score_milli.min(150), history.score_generation))
            .unwrap_or((100, 0));
        let auth_key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            Some(auth_alias),
            None,
        );
        let auth_key_cooldown = state
            .auth_key_cooldowns
            .get(&auth_key)
            .is_some_and(|cooldown| cooldown.until_ms.is_none_or(|until| until > _now_ms));
        let auth_key_probe = key_blocks_availability(&state, &auth_key, _now_ms);
        // score 是同一 configured priority bucket 内的调度权重，不是可用性。
        // 低优先级 key 在一次 -5 后可能已经 score=0，但只有连击达到阈值后
        // 创建的 cooldown/probe 状态才允许把候选从 Target selection 中移除。
        let available = !key_blocks_availability(&state, &key, _now_ms)
            && !auth_key_cooldown
            && !auth_key_probe;
        Ok(V3ProviderSchedulingProjection {
            provider_id: provider_id.to_string(),
            interface_id: interface_id.to_string(),
            auth_alias: auth_alias.to_string(),
            model_id: model_id.to_string(),
            priority,
            effective_priority: priority,
            score_milli,
            base_weight,
            effective_weight_milli: u64::from(base_weight.max(1)).saturating_mul(100),
            available,
            blocked_scopes: if available {
                Vec::new()
            } else {
                vec!["provider_key_health_cooldown".to_string()]
            },
            score_generation,
        })
    }

    pub fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> Result<V3ProviderSchedulingProjection, V3ProviderHealthError> {
        self.scheduling_projection_for_key(
            provider_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        )
    }

    pub(crate) fn update_quota_state(
        &self,
        scope: &V3ErrorActionScope,
        remaining: u64,
        reset_at_ms: Option<u64>,
    ) -> Result<V3ProviderQuotaState, V3ProviderHealthError> {
        let quota = V3ProviderQuotaState {
            scope_label: scope_label(scope),
            remaining,
            reset_at_ms,
        };
        self.state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?
            .quotas
            .insert(quota.scope_label.clone(), quota.clone());
        Ok(quota)
    }

    pub fn availability_for_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        self.availability_for_session_for_interface(
            failure_session_scope,
            provider_id,
            "default",
            auth_alias,
            model_id,
            now_ms,
        )
    }

    pub fn availability_for_session_for_interface(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        let key = provider_failure_session_key_for_interface(
            failure_session_scope,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        remove_expired_session_state(&mut state, now_ms);
        let mut projection = global_availability_projection(
            &state,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
        );
        if let Some(cooldown) = state.auth_key_cooldowns.iter().find_map(|(key, cooldown)| {
            (key.provider_id == provider_id
                && key.interface_id == interface_id
                && key.auth_alias.as_deref() == auth_alias
                && cooldown.until_ms.is_none_or(|until| until > now_ms))
            .then_some(cooldown)
        }) {
            projection.available = false;
            projection.blocked_scopes.push(match cooldown.until_ms {
                Some(until_ms) => format!(
                    "auth_key:{provider_id}:{interface_id}:{}:until:{until_ms}",
                    auth_alias.unwrap_or("-")
                ),
                None => format!(
                    "auth_key:{provider_id}:{interface_id}:{}",
                    auth_alias.unwrap_or("-")
                ),
            });
        }
        let session_cooldown = state
            .cooldowns
            .get(&key)
            .filter(|cooldown| cooldown.until_ms.is_none_or(|until_ms| until_ms > now_ms));
        if let Some(cooldown) = session_cooldown {
            projection.blocked_scopes.push(match cooldown.until_ms {
                Some(until_ms) => format!(
                    "{}:{}:until:{until_ms}",
                    provider_failure_session_scope_label(&key),
                    cooldown.reason
                ),
                None => format!(
                    "{}:{}",
                    provider_failure_session_scope_label(&key),
                    cooldown.reason
                ),
            });
            projection.available = false;
        }
        // provider 级冷却探针（跨 session 共享）：冷却期/待探期/探针执行中，
        // 该 provider 对全部 session 的常规选择不可用，恢复唯一路径是后台
        // An advisory probe never blocks selection: its pending state is a
        // scheduling detail, not an availability decision. Only a real business
        // cooldown may exclude the identity.
        let cooldown_probe_pending = key_blocks_availability(
            &state,
            &provider_cooldown_probe_key_for_interface(
                provider_id,
                interface_id,
                auth_alias,
                model_id,
            ),
            now_ms,
        ) || key_blocks_availability(
            &state,
            &crate::provider_cooldown_probe::session_cooldown_probe_key_for_interface(
                failure_session_scope,
                provider_id,
                interface_id,
                auth_alias,
                model_id,
            ),
            now_ms,
        );
        if cooldown_probe_pending {
            projection.available = false;
            if !projection
                .blocked_scopes
                .iter()
                .any(|scope| scope == "provider_cooldown_probe_pending")
            {
                projection
                    .blocked_scopes
                    .push("provider_cooldown_probe_pending".to_string());
            }
        }
        Ok(projection)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct V3CooldownPoolEntry {
    pub provider_id: String,
    pub interface_id: String,
    pub auth_alias: Option<String>,
    pub model_id: Option<String>,
    pub state: String,
    pub until_ms: Option<u64>,
    pub remaining_ms: Option<i64>,
    pub reason: Option<String>,
    pub failure_count: Option<u32>,
    pub kind: String,
}

impl V3ProviderHealthStore {
    /// Explicit operator action: remove matching cooldown/probe state and
    /// persist the resulting global cooldown projection.
    pub fn remove_cooldown_entry_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        kind: &str,
    ) -> Result<bool, V3ProviderHealthError> {
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let mut removed = false;
        match kind {
            "session" => {
                let keys = state
                    .cooldowns
                    .keys()
                    .filter(|key| {
                        key.provider_id == provider_id
                            && key.interface_id == interface_id
                            && auth_alias
                                .is_none_or(|alias| key.auth_alias.as_deref() == Some(alias))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                for key in keys {
                    removed |= state.cooldowns.remove(&key).is_some();
                    state.consecutive_failures.remove(&key);
                }
            }
            "auth_key" => {
                let key = provider_cooldown_probe_key_for_interface(
                    provider_id,
                    interface_id,
                    auth_alias,
                    None,
                );
                removed |= state.auth_key_cooldowns.remove(&key).is_some();
                removed |= state.provider_cooldown_probes.remove(&key).is_some();
            }
            "probe" => {
                let key = provider_cooldown_probe_key_for_interface(
                    provider_id,
                    interface_id,
                    auth_alias,
                    model_id,
                );
                removed |= state.provider_cooldown_probes.remove(&key).is_some();
                if removed {
                    state.adaptive_history.remove(&key);
                }
            }
            _ => return Ok(false),
        }
        if removed {
            persist_cooldown_state(state);
        }
        Ok(removed)
    }

    /// Returns all current cooldown entries (session + auth_key + provider-level probes).
    /// Entries with no remaining time are excluded.
    pub fn cooldown_entries(&self, now_ms: u64) -> Vec<V3CooldownPoolEntry> {
        let state = match self.state.read() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let mut entries = Vec::new();

        // Session cooldowns
        for (key, cooldown) in &state.cooldowns {
            let remaining = cooldown.until_ms.map(|u| u.saturating_sub(now_ms) as i64);
            if remaining.is_some_and(|r| r <= 0) {
                continue;
            }
            let failure_count = state.consecutive_failures.get(key).map(|f| f.failure_count);
            entries.push(V3CooldownPoolEntry {
                provider_id: key.provider_id.clone(),
                interface_id: key.interface_id.clone(),
                auth_alias: key.auth_alias.clone(),
                model_id: key.model_id.clone(),
                state: "session_cooldown".to_string(),
                until_ms: cooldown.until_ms,
                remaining_ms: remaining,
                reason: Some(cooldown.reason.clone()),
                failure_count,
                kind: "session".to_string(),
            });
        }

        // Explicit operator auth-key cooldowns; automatic failures never write these.
        for (key, cooldown) in &state.auth_key_cooldowns {
            let remaining = cooldown.until_ms.map(|u| u.saturating_sub(now_ms) as i64);
            if remaining.is_some_and(|r| r <= 0) {
                continue;
            }
            entries.push(V3CooldownPoolEntry {
                provider_id: key.provider_id.clone(),
                interface_id: key.interface_id.clone(),
                auth_alias: key.auth_alias.clone(),
                model_id: None,
                state: "auth_key_cooldown".to_string(),
                until_ms: cooldown.until_ms,
                remaining_ms: remaining,
                reason: Some(cooldown.reason.clone()),
                failure_count: None,
                kind: "auth_key".to_string(),
            });
        }

        // Provider cooldown probes (global)
        for (key, probe) in &state.provider_cooldown_probes {
            let blocked = probe.blocked_until_ms.is_some_and(|u| u > now_ms);
            // A deadline only makes recovery due. Retained exclusions remain
            // in the pool while waiting or probing, until semantic recovery.
            let state_str = if probe.active_probe.is_some() {
                "probing".to_string()
            } else if blocked {
                "blocked".to_string()
            } else if probe.next_probe_at_ms.is_some() || probe.blocked_until_ms.is_some() {
                "waiting".to_string()
            } else {
                continue;
            };
            entries.push(V3CooldownPoolEntry {
                provider_id: key.provider_id.clone(),
                interface_id: key.interface_id.clone(),
                auth_alias: key.auth_alias.clone(),
                model_id: key.model_id.clone(),
                state: state_str,
                until_ms: probe.blocked_until_ms.filter(|u| *u > now_ms),
                remaining_ms: probe
                    .blocked_until_ms
                    .map(|u| u.saturating_sub(now_ms) as i64),
                reason: None,
                failure_count: Some(u32::from(probe.probe_failure_count)),
                kind: "probe".to_string(),
            });
        }

        entries
    }
}

#[cfg(test)]
impl V3ProviderHealthStore {
    fn remove_cooldown_entry(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        kind: &str,
    ) -> Result<bool, V3ProviderHealthError> {
        self.remove_cooldown_entry_for_interface(provider_id, "default", auth_alias, model_id, kind)
    }
}

fn default_failure_policy_from_manifest(
    manifest: &V3Config05ManifestPublished,
) -> V3ProviderFailurePolicy {
    let (cooldown_ms, until_restart) = manifest
        .error
        .provider_error_default_path
        .iter()
        .find_map(|step| match step {
            V3ProviderDispositionStepManifest::Cooldown {
                duration_ms: Some(duration_ms),
                ..
            } => Some(((*duration_ms).max(1), false)),
            V3ProviderDispositionStepManifest::Cooldown {
                until_restart: Some(true),
                ..
            } => Some((1, true)),
            _ => None,
        })
        .expect("compiled provider error default path must contain cooldown");
    V3ProviderFailurePolicy {
        failure_threshold: V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
        cooldown_ms,
        probe_interval_ms: V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart,
        advisory_probe: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    }
}

impl V3ProviderAvailabilityReader for V3ProviderHealthStore {
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        self.expire_rate_limit_day(provider_id, interface_id, auth_alias, model_id, now_ms)?;
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        Ok(global_availability_projection(
            &state,
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
        ))
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderAvailabilityProjection, V3ProviderHealthError> {
        self.expire_rate_limit_day(provider_id, "default", auth_alias, model_id, now_ms)?;
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        Ok(global_availability_projection(&state, provider_id, "default", auth_alias, model_id, now_ms))
    }
}

impl V3ProviderHealthStore {
    fn expire_rate_limit_day(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let key = provider_cooldown_probe_key_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        );
        let expired = {
            let state = self
                .state
                .read()
                .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
            rate_limit::is_expired_day(&state, &key, now_ms)
        };
        if !expired {
            return Ok(());
        }
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        if rate_limit::reset_expired_day(&mut state, &key, now_ms) {
            persist_cooldown_state(state);
            self.publish_availability_change();
        }
        Ok(())
    }
}

pub(crate) fn explain_provider_health_reasons(
    store: &V3ProviderHealthStore,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> Vec<String> {
    let keys = availability_scope_keys(provider_id, "default", auth_alias, model_id);
    let state = store
        .state
        .read()
        .expect("provider health lock should not be poisoned in diagnostic projection");
    state
        .quotas
        .values()
        .filter(|quota| {
            keys.contains(&quota.scope_label)
                && quota.remaining == 0
                && quota
                    .reset_at_ms
                    .is_none_or(|reset_at_ms| reset_at_ms > now_ms)
        })
        .map(|quota| format!("quota:{}:exhausted", quota.scope_label))
        .collect()
}

fn global_availability_projection(
    state: &V3ProviderHealthState,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> V3ProviderAvailabilityProjection {
    let keys = availability_scope_keys(provider_id, interface_id, auth_alias, model_id);
    let mut blocked_scopes = Vec::new();
    if state.configured_disabled.contains(provider_id) {
        blocked_scopes.push(format!(
            "configured_disabled:provider_instance:{provider_id}"
        ));
    }
    // `health.enabled=false` 表示"不启用 health 跟踪"：provider 视为永远可用
    // （失败不记录、不冷却、不阻断，与 record_provider_failure 的
    // health_disabled 短路一致），而不是"被 health 禁用"。只有
    // `provider.enabled=false`（configured_disabled）才是真正的禁用。
    blocked_scopes.extend(
        keys.iter()
            .filter(|key| {
                state.quotas.get(*key).is_some_and(|quota| {
                    quota.remaining == 0
                        && quota
                            .reset_at_ms
                            .is_none_or(|reset_at_ms| reset_at_ms > now_ms)
                })
            })
            .map(|key| format!("quota:{key}")),
    );
    if key_blocks_availability(
        state,
        &provider_cooldown_probe_key_for_interface(provider_id, interface_id, auth_alias, model_id),
        now_ms,
    ) || key_blocks_availability(
        state,
        &provider_cooldown_probe_key_for_interface(provider_id, interface_id, auth_alias, None),
        now_ms,
    ) {
        blocked_scopes.push("provider_cooldown_probe_pending".to_string());
    }
    if state.auth_key_cooldowns.iter().any(|(key, cooldown)| {
        key.provider_id == provider_id
            && key.interface_id == interface_id
            && key.auth_alias.as_deref() == auth_alias
            && cooldown.until_ms.is_none_or(|until| until > now_ms)
    }) {
        blocked_scopes.push(format!(
            "auth_key:{provider_id}:{}",
            auth_alias.unwrap_or("-")
        ));
    }
    V3ProviderAvailabilityProjection {
        provider_id: provider_id.to_string(),
        interface_id: interface_id.to_string(),
        auth_alias: auth_alias.map(ToOwned::to_owned),
        model_id: model_id.map(ToOwned::to_owned),
        available: blocked_scopes.is_empty(),
        blocked_scopes,
    }
}

include!("health/runtime_projection.rs");
include!("health/legacy_api.rs");

#[cfg(test)]
#[path = "health_tests.rs"]
mod tests;
