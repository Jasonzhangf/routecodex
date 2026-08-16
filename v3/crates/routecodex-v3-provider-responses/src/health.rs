use crate::provider_cooldown_probe::{
    provider_cooldown_probe_key, V3ProviderCooldownProbeKey, V3ProviderCooldownProbeState,
    V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
};
use crate::provider_global_health::V3ProviderGlobalSubscriptionHealthStore;
use routecodex_v3_config::{V3Config05ManifestPublished, V3ProviderDispositionStepManifest};
use routecodex_v3_error::{V3ErrorActionScope, V3ProviderFailureSessionScope};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderAvailabilityProjection {
    pub provider_id: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderConcurrencyState {
    pub provider_id: String,
    pub in_flight: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailurePolicy {
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
    pub until_restart: bool,
}

impl Default for V3ProviderFailurePolicy {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
            cooldown_ms: 900_000,
            until_restart: false,
        }
    }
}

/// 瞬态失败（SSE 流内/挂起）耗尽 3 次尝试后的 session 级短期绕行时长：
/// 不触发 15 分钟 cooldown（health-neutral），但同一 session 的后续请求
/// 在该窗口内绕开该 provider，避免反复命中同一失败 provider；超时自动恢复。
pub const V3_PROVIDER_TRANSIENT_BYPASS_MS: u64 = 30_000;

/// provider 级冷却的复活探针间隔：冷却到期后，后台每 15 分钟对冷却中的
/// provider 发一次最小 ping，通过才恢复（业务请求在冷却期间永不命中）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailureRecord {
    pub scope_label: String,
    pub provider_key: String,
    pub state: String,
    pub failure_count: u32,
    pub cooldown_until_ms: Option<u64>,
    pub reason: Option<String>,
}

pub trait V3ProviderAvailabilityReader {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection;
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
    ) -> V3ProviderAvailabilityProjection {
        V3ProviderAvailabilityProjection {
            provider_id: provider_id.to_string(),
            auth_alias: auth_alias.map(ToOwned::to_owned),
            model_id: model_id.map(ToOwned::to_owned),
            available: true,
            blocked_scopes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderHealthStore {
    state: Arc<RwLock<V3ProviderHealthState>>,
    global_subscription_store: V3ProviderGlobalSubscriptionHealthStore,
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
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
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

#[derive(Debug, Default)]
struct V3ProviderHealthState {
    configured_disabled: BTreeSet<String>,
    health_disabled: BTreeSet<String>,
    failure_policies: BTreeMap<String, V3ProviderFailurePolicy>,
    consecutive_failures: BTreeMap<String, V3ProviderConsecutiveFailure>,
    cooldowns: BTreeMap<V3ProviderFailureSessionKey, V3ProviderCooldown>,
    provider_cooldown_probes: BTreeMap<V3ProviderCooldownProbeKey, V3ProviderCooldownProbeState>,
    quotas: BTreeMap<String, V3ProviderQuotaState>,
    concurrency: BTreeMap<String, V3ProviderConcurrencyState>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ProviderFailureSessionKey {
    server_id: String,
    routing_group: String,
    session_id: String,
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
}

#[derive(Debug, thiserror::Error)]
pub enum V3ProviderHealthError {
    #[error("provider health state lock poisoned: {0}")]
    Poisoned(String),
}

impl V3ProviderHealthStore {
    pub fn from_manifest(manifest: &V3Config05ManifestPublished) -> Self {
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
                            until_restart: false,
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
        Self {
            state: Arc::new(RwLock::new(V3ProviderHealthState {
                configured_disabled,
                health_disabled,
                failure_policies,
                ..V3ProviderHealthState::default()
            })),
            global_subscription_store: V3ProviderGlobalSubscriptionHealthStore::default(),
        }
    }

    pub fn global_subscription_store(&self) -> V3ProviderGlobalSubscriptionHealthStore {
        self.global_subscription_store.clone()
    }

    pub fn record_provider_failure_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        self.record_provider_failure_in_session_with_policy(
            failure_session_scope,
            provider_id,
            auth_alias,
            model_id,
            reason,
            now_ms,
            None,
        )
    }

    pub fn record_provider_failure_in_session_with_policy(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        reason: Option<&str>,
        now_ms: u64,
        policy_override: Option<V3ProviderFailurePolicy>,
    ) -> Result<V3ProviderFailureRecord, V3ProviderHealthError> {
        let provider_key = provider_key_label(provider_id, auth_alias, model_id);
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
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
                reason: reason.map(str::to_string),
            });
        }
        if state
            .cooldowns
            .get(&key)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until > now_ms))
        {
            let failure_count = state
                .consecutive_failures
                .get(&provider_key)
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
                reason: reason.map(str::to_string),
            });
        }
        if state
            .cooldowns
            .get(&key)
            .is_some_and(|cooldown| cooldown.until_ms.is_some_and(|until| until <= now_ms))
        {
            state.cooldowns.remove(&key);
            state.consecutive_failures.remove(&provider_key);
        }
        let policy = policy_override.unwrap_or_else(|| {
            state
                .failure_policies
                .get(provider_id)
                .copied()
                .unwrap_or_default()
        });
        let failure = state
            .consecutive_failures
            .entry(provider_key.clone())
            .or_insert(V3ProviderConsecutiveFailure {
                failure_count: 0,
                last_failure_at_ms: now_ms,
                reason: None,
            });
        failure.failure_count = failure.failure_count.saturating_add(1);
        failure.last_failure_at_ms = now_ms;
        if let Some(reason) = reason.filter(|value| !value.trim().is_empty()) {
            failure.reason = Some(reason.to_string());
        }
        let failure_count = failure.failure_count;
        let record_reason = failure.reason.clone();
        let mut cooldown_until_ms = None;
        let mut record_state = "healthy".to_string();
        // provider key 的计数跨 session 累积；reason 仅作诊断，不参与
        // 计数分桶或重置。同一 key 任意连续三次 provider error 都冷却。
        if failure_count >= policy.failure_threshold {
            cooldown_until_ms =
                (!policy.until_restart).then(|| now_ms.saturating_add(policy.cooldown_ms));
            record_state = "cooldown".to_string();
            let cooldown = V3ProviderCooldown {
                reason: record_reason
                    .clone()
                    .unwrap_or_else(|| "provider_consecutive_failures".to_string()),
                until_ms: cooldown_until_ms,
            };
            state.cooldowns.insert(key.clone(), cooldown);
            if let Some(until_ms) = cooldown_until_ms {
                upsert_provider_cooldown_probe(
                    &mut state,
                    provider_id,
                    auth_alias,
                    model_id,
                    until_ms,
                );
            }
        }
        Ok(V3ProviderFailureRecord {
            scope_label,
            provider_key,
            state: record_state,
            failure_count,
            cooldown_until_ms,
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
        let provider_key = provider_key_label(provider_id, auth_alias, model_id);
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
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
                .get(&provider_key)
                .map_or(0, |failure| failure.failure_count);
            return Ok(V3ProviderFailureRecord {
                scope_label,
                provider_key,
                state: "cooldown".to_string(),
                failure_count,
                cooldown_until_ms: cooldown.until_ms,
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
            reason: reason.map(str::to_string),
        })
    }

    /// 成功响应清零该 key 的连续失败与 session cooldown。已经形成的
    /// provider cooldown/probe block 只能由注册 probe 的 2xx 完成事件清除。
    pub fn record_provider_success_in_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
        let provider_identity = provider_key_label(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        state.cooldowns.remove(&key);
        state.consecutive_failures.remove(&provider_identity);
        state
            .cooldowns
            .retain(|cooldown_key, _| cooldown_key.provider_runtime_identity != provider_identity);
        let _ = now_ms;
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
        let blocked_until_ms = now_ms.saturating_add(cooldown_ms.max(1));
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        upsert_provider_cooldown_probe(
            &mut state,
            provider_id,
            auth_alias,
            model_id,
            blocked_until_ms,
        );
        let _ = reason;
        Ok(())
    }

    /// provider 级冷却中、冷却已到期且 probe 到期的 provider 列表
    /// （(provider_id, auth_alias, model_id)）。由后台 probe 循环消费。
    pub fn provider_cooldown_probe_keys_due(
        &self,
        now_ms: u64,
    ) -> Result<Vec<(String, Option<String>, Option<String>)>, V3ProviderHealthError> {
        let state = self
            .state
            .read()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        Ok(state
            .provider_cooldown_probes
            .iter()
            .filter(|(_, probe_state)| {
                !probe_state.probe_in_flight
                    && probe_state.blocked_until_ms.is_some()
                    && probe_state
                        .next_probe_at_ms
                        .is_some_and(|next_probe_at_ms| next_probe_at_ms <= now_ms)
            })
            .map(|(key, probe_state)| {
                (
                    key.provider_id.clone(),
                    key.auth_alias.clone(),
                    probe_state.probe_model_id.clone(),
                )
            })
            .collect())
    }

    /// 标记 provider 级冷却的 probe 为进行中（防止重复探测）。
    pub fn try_acquire_provider_cooldown_probe(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<bool, V3ProviderHealthError> {
        let key = provider_cooldown_probe_key(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(&key) else {
            return Ok(false);
        };
        if probe_state.probe_in_flight || probe_state.blocked_until_ms.is_none() {
            return Ok(false);
        }
        probe_state.probe_in_flight = true;
        probe_state.completion.send_replace(false);
        Ok(true)
    }

    /// 完整候选集耗尽时，每个 cooldown generation 只允许一次强制自救 probe。
    pub fn try_acquire_provider_cooldown_rescue_probe(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<bool, V3ProviderHealthError> {
        let key = provider_cooldown_probe_key(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(&key) else {
            return Ok(false);
        };
        if probe_state.probe_in_flight || probe_state.rescue_probe_attempted {
            return Ok(false);
        }
        probe_state.probe_in_flight = true;
        probe_state.rescue_probe_attempted = true;
        probe_state.completion.send_replace(false);
        Ok(true)
    }

    /// 并发耗尽请求等待同一 key 的单飞 probe 收口，不重复发送 probe。
    pub async fn wait_for_provider_cooldown_probe_completion(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<(), V3ProviderHealthError> {
        loop {
            let mut completion = {
                let state = self
                    .state
                    .read()
                    .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
                state
                    .provider_cooldown_probes
                    .get(&provider_cooldown_probe_key(
                        provider_id,
                        auth_alias,
                        model_id,
                    ))
                    .filter(|probe_state| probe_state.probe_in_flight)
                    .map(|probe_state| probe_state.completion.subscribe())
            };
            let Some(mut completion) = completion.take() else {
                return Ok(());
            };
            if !*completion.borrow_and_update() {
                completion
                    .changed()
                    .await
                    .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
            }
        }
    }

    /// probe 通过：清除 provider 级冷却，provider 复活（业务路由恢复可达）。
    pub fn complete_provider_cooldown_probe_success(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<(), V3ProviderHealthError> {
        let key = provider_cooldown_probe_key(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let completion = state
            .provider_cooldown_probes
            .remove(&key)
            .map(|probe_state| probe_state.completion);
        let provider_identity = provider_key_label(provider_id, auth_alias, model_id);
        state.consecutive_failures.remove(&provider_identity);
        state
            .cooldowns
            .retain(|cooldown_key, _| cooldown_key.provider_runtime_identity != provider_identity);
        if let Some(completion) = completion {
            completion.send_replace(true);
        }
        Ok(())
    }

    /// probe 失败：保持冷却，推后下一次探针。
    pub fn complete_provider_cooldown_probe_failure(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<(), V3ProviderHealthError> {
        let key = provider_cooldown_probe_key(provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(&key) else {
            return Ok(());
        };
        probe_state.probe_in_flight = false;
        probe_state.next_probe_at_ms =
            Some(now_ms.saturating_add(V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS.max(1)));
        probe_state.completion.send_replace(true);
        Ok(())
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

    pub(crate) fn update_concurrency_state(
        &self,
        provider_id: impl Into<String>,
        in_flight: u32,
        limit: u32,
    ) -> Result<V3ProviderConcurrencyState, V3ProviderHealthError> {
        let provider_id = provider_id.into();
        let concurrency = V3ProviderConcurrencyState {
            provider_id: provider_id.clone(),
            in_flight,
            limit,
        };
        self.state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?
            .concurrency
            .insert(provider_id, concurrency.clone());
        Ok(concurrency)
    }

    pub fn availability_for_session(
        &self,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let key =
            provider_failure_session_key(failure_session_scope, provider_id, auth_alias, model_id);
        let mut state = self
            .state
            .write()
            .expect("provider health lock should not be poisoned in session projection");
        remove_expired_session_state(&mut state, now_ms);
        let mut projection =
            global_availability_projection(&state, provider_id, auth_alias, model_id, now_ms);
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
        // 全局订阅不可用由 runtime 的
        // `V3SessionGlobalAvailabilityReader`/`V3ProviderFailureRuntimeHealth`
        // 单点投影（一次 push）；这里不重复 push，避免日志出现
        // `provider_global_subscription_failure|provider_global_subscription_failure`。
        projection
    }
}

fn default_failure_policy_from_manifest(
    manifest: &V3Config05ManifestPublished,
) -> V3ProviderFailurePolicy {
    let threshold = manifest
        .error
        .provider_error_default_path
        .iter()
        .find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry { max_attempts, .. } => {
                Some((*max_attempts).max(1))
            }
            _ => None,
        })
        .unwrap_or(1);
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
        failure_threshold: threshold,
        cooldown_ms,
        until_restart,
    }
}

impl V3ProviderAvailabilityReader for V3ProviderHealthStore {
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let state = self
            .state
            .read()
            .expect("provider health lock should not be poisoned in projection");
        global_availability_projection(&state, provider_id, auth_alias, model_id, now_ms)
    }
}

pub(crate) fn explain_provider_health_reasons(
    store: &V3ProviderHealthStore,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> Vec<String> {
    let keys = availability_scope_keys(provider_id, auth_alias, model_id);
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
        .chain(
            state
                .concurrency
                .get(provider_id)
                .filter(|concurrency| {
                    concurrency.limit > 0 && concurrency.in_flight >= concurrency.limit
                })
                .map(|concurrency| {
                    format!(
                        "concurrency:provider_instance:{}:{}/{}",
                        provider_id, concurrency.in_flight, concurrency.limit
                    )
                }),
        )
        .collect()
}

fn global_availability_projection(
    state: &V3ProviderHealthState,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> V3ProviderAvailabilityProjection {
    let keys = availability_scope_keys(provider_id, auth_alias, model_id);
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
    if state
        .concurrency
        .get(provider_id)
        .is_some_and(|concurrency| {
            concurrency.limit > 0 && concurrency.in_flight >= concurrency.limit
        })
    {
        blocked_scopes.push(format!("concurrency:provider_instance:{provider_id}"));
    }
    let cooldown_probe = state
        .provider_cooldown_probes
        .get(&provider_cooldown_probe_key(
            provider_id,
            auth_alias,
            model_id,
        ));
    if cooldown_probe.is_some_and(|probe_state| {
        probe_state.probe_in_flight
            || probe_state.next_probe_at_ms.is_some()
            || probe_state
                .blocked_until_ms
                .is_some_and(|blocked_until_ms| blocked_until_ms > now_ms)
    }) {
        blocked_scopes.push("provider_cooldown_probe_pending".to_string());
    }
    V3ProviderAvailabilityProjection {
        provider_id: provider_id.to_string(),
        auth_alias: auth_alias.map(ToOwned::to_owned),
        model_id: model_id.map(ToOwned::to_owned),
        available: blocked_scopes.is_empty(),
        blocked_scopes,
    }
}

fn provider_failure_session_key(
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3ProviderFailureSessionKey {
    V3ProviderFailureSessionKey {
        server_id: failure_session_scope.server_id().to_string(),
        routing_group: failure_session_scope.routing_group().to_string(),
        session_id: failure_session_scope.session_id().to_string(),
        provider_runtime_identity: provider_key_label(provider_id, auth_alias, model_id),
    }
}

fn provider_failure_session_scope_label(key: &V3ProviderFailureSessionKey) -> String {
    format!(
        "provider_failure_session:{}:{}:{}:{}",
        key.server_id, key.routing_group, key.session_id, key.provider_runtime_identity
    )
}

fn remove_expired_session_state(state: &mut V3ProviderHealthState, now_ms: u64) {
    const SESSION_STATE_IDLE_TTL_MS: u64 = 30 * 60_000;
    state
        .cooldowns
        .retain(|_, cooldown| cooldown.until_ms.is_none_or(|until_ms| until_ms > now_ms));
    // provider 级冷却探针状态独立于 session 冷却：冷却期、待探期、探针
    // 执行中都保留，只有 `complete_provider_cooldown_probe_success` 清除。
    state.provider_cooldown_probes.retain(|_, probe_state| {
        probe_state.probe_in_flight
            || probe_state.next_probe_at_ms.is_some()
            || probe_state
                .blocked_until_ms
                .is_some_and(|blocked_until_ms| blocked_until_ms > now_ms)
    });
    // provider 级冷却：冷却期（until 未过期）与待探期（next_probe_at 已设）
    // 都保留——冷却到期不自动恢复，必须后台 probe 通过；无探针的过期条目
    // 视为异常态清理。
    state.consecutive_failures.retain(|_, failure| {
        failure
            .last_failure_at_ms
            .saturating_add(SESSION_STATE_IDLE_TTL_MS)
            > now_ms
    });
}

fn availability_scope_keys(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> Vec<String> {
    let mut keys = vec![format!("provider_instance:{provider_id}")];
    if let Some(auth_alias) = auth_alias {
        keys.push(format!("auth_key:{provider_id}:{auth_alias}"));
    }
    if let Some(model_id) = model_id {
        keys.push(format!("canonical_model:{provider_id}:{model_id}"));
    }
    if auth_alias.is_some() || model_id.is_some() {
        keys.push(provider_key_scope_label(provider_id, auth_alias, model_id));
    }
    keys
}

fn provider_key_scope_label(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "provider_key:{}",
        provider_key_label(provider_id, auth_alias, model_id)
    )
}

fn provider_key_label(
    provider_id: &str,
    auth_alias: Option<&str>,
    _model_id: Option<&str>,
) -> String {
    format!("{}:{}", provider_id, auth_alias.unwrap_or("-"))
}

fn upsert_provider_cooldown_probe(
    state: &mut V3ProviderHealthState,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    blocked_until_ms: u64,
) {
    // 已有 probe 在途时保留 in-flight 标记：并发失败 re-upsert 不得清掉
    // 单飞锁，否则会并发启动第二个 probe。
    let existing = state
        .provider_cooldown_probes
        .get(&provider_cooldown_probe_key(
            provider_id,
            auth_alias,
            model_id,
        ));
    let probe_in_flight = existing.is_some_and(|probe_state| probe_state.probe_in_flight);
    let rescue_probe_attempted =
        existing.is_some_and(|probe_state| probe_state.rescue_probe_attempted);
    let completion = existing
        .map(|probe_state| probe_state.completion.clone())
        .unwrap_or_else(|| tokio::sync::watch::channel(false).0);
    state.provider_cooldown_probes.insert(
        provider_cooldown_probe_key(provider_id, auth_alias, model_id),
        V3ProviderCooldownProbeState {
            blocked_until_ms: Some(blocked_until_ms),
            next_probe_at_ms: Some(blocked_until_ms),
            probe_in_flight,
            probe_model_id: model_id.map(str::to_string),
            rescue_probe_attempted,
            completion,
        },
    );
}

fn scope_label(scope: &V3ErrorActionScope) -> String {
    match scope {
        V3ErrorActionScope::None => "none".to_string(),
        V3ErrorActionScope::ProviderInstance { provider_id } => {
            format!("provider_instance:{provider_id}")
        }
        V3ErrorActionScope::AuthKey {
            provider_id,
            auth_alias,
        } => format!("auth_key:{provider_id}:{auth_alias}"),
        V3ErrorActionScope::CanonicalModel {
            provider_id,
            model_id,
        } => format!("canonical_model:{provider_id}:{model_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

    fn session(session_id: &str) -> V3ProviderFailureSessionScope {
        V3ProviderFailureSessionScope::new("server-a", "group-a", session_id).unwrap()
    }

    #[test]
    fn manifest_disabled_provider_is_projected_as_unavailable_by_provider_owner() {
        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.disabled]
enabled = false
type = "responses"
base_url = "http://disabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.disabled.models.m]
[providers.enabled]
type = "responses"
base_url = "http://enabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.enabled.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "enabled", model = "m", key = "k", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();
        let availability = V3ProviderAvailabilityRegistry::from_manifest(&manifest);
        assert!(
            !availability
                .availability("disabled", Some("k"), Some("m"), 0)
                .available
        );
        assert!(
            availability
                .availability("enabled", Some("k"), Some("m"), 0)
                .available
        );
    }

    #[test]
    fn three_failures_cool_and_share_provider_cooldown_across_sessions() {
        let store = V3ProviderHealthStore::default();
        for now_ms in 100..103 {
            store
                .record_provider_failure_in_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    Some("controlled failure"),
                    now_ms,
                )
                .unwrap();
        }
        assert!(
            !store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    103,
                )
                .available
        );
        assert!(
            !store
                .availability_for_session(
                    &session("session-b"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    103,
                )
                .available,
            "provider-level cooldown must propagate to other sessions"
        );
    }

    #[test]
    fn one_failure_in_other_session_shares_provider_key_cooldown() {
        let store = V3ProviderHealthStore::default();
        for (index, session_id) in ["session-a", "session-a", "session-a", "session-b"]
            .into_iter()
            .enumerate()
        {
            let record = store
                .record_provider_failure_in_session(
                    &session(session_id),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    Some("controlled failure"),
                    100 + index as u64,
                )
                .unwrap();
            if index == 3 {
                assert_eq!(record.state, "cooldown");
                assert_eq!(record.failure_count, 4);
            }
        }
        for (key, available) in [("key-a", false), ("key-b", true)] {
            assert_eq!(
                store
                    .availability_for_session(
                        &session("session-b"),
                        "provider-a",
                        Some(key),
                        Some("gpt-5.5"),
                        105,
                    )
                    .available,
                available
            );
        }
    }

    #[test]
    fn success_in_one_session_revives_provider_for_all_sessions() {
        let store = V3ProviderHealthStore::default();
        for now_ms in 100..103 {
            store
                .record_provider_failure_in_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    Some("controlled failure"),
                    now_ms,
                )
                .unwrap();
        }
        assert!(
            !store
                .availability_for_session(
                    &session("session-b"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    103,
                )
                .available
        );
        // session-b 成功只清 session 级冷却：provider 级冷却在冷却未到期时
        // 不被业务成功复活（复活前必须先 probe）。
        store
            .record_provider_success_in_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                104,
            )
            .unwrap();
        assert!(
            !store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    105,
                )
                .available,
            "provider-level cooldown must not be cleared by a sibling success"
        );
        assert!(
            !store
                .availability_for_session(
                    &session("session-b"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    105,
                )
                .available,
            "provider-level cooldown suppresses every session including the succeeding one"
        );
        // probe 到期 → 通过 → provider 级冷却清除，全部 session 恢复。
        assert!(store
            .provider_cooldown_probe_keys_due(103 + 900_000 + 15 * 60_000 + 1)
            .unwrap()
            .contains(&(
                "provider-a".to_string(),
                Some("key-a".to_string()),
                Some("gpt-5.5".to_string())
            )));
        assert!(store
            .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap());
        store
            .complete_provider_cooldown_probe_success("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap();
        assert!(
            store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    106,
                )
                .available,
            "probe success must revive provider for all sessions"
        );
    }

    #[test]
    fn success_after_provider_cooldown_expires_still_requires_probe() {
        let store = V3ProviderHealthStore::default();
        store
            .record_provider_cooldown_failure(
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                "post-commit stream failure",
                100,
                10,
            )
            .unwrap();
        // 冷却未到期（blocked_until=110 > 105）：session 成功不清 provider 级冷却。
        store
            .record_provider_success_in_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                105,
            )
            .unwrap();
        assert!(
            !store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    105,
                )
                .available,
            "unexpired provider cooldown must still require probe before revival"
        );
        // 冷却已到期（110）但 probe 尚未跑：业务成功只清失败计数，不能复活。
        store
            .record_provider_success_in_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                110,
            )
            .unwrap();
        assert!(
            !store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    111,
                )
                .available,
            "expired provider cooldown must remain blocked until a provider probe succeeds"
        );
        store
            .complete_provider_cooldown_probe_success("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap();
        assert!(
            store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    112,
                )
                .available
        );
    }

    #[test]
    fn cooldown_reupsert_preserves_in_flight_probe_single_flight() {
        let store = V3ProviderHealthStore::default();
        store
            .record_provider_cooldown_failure(
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                "first failure",
                100,
                900_000,
            )
            .unwrap();
        assert!(store
            .provider_cooldown_probe_keys_due(100 + 900_000 + 1)
            .unwrap()
            .contains(&(
                "provider-a".to_string(),
                Some("key-a".to_string()),
                Some("gpt-5.5".to_string())
            )));
        assert!(
            store
                .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
                .unwrap(),
            "probe must be acquirable once"
        );
        // 探针在途时并发失败 re-upsert：不得清掉 in-flight 单飞锁。
        store
            .record_provider_cooldown_failure(
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                "concurrent failure",
                200,
                900_000,
            )
            .unwrap();
        assert!(
            !store
                .provider_cooldown_probe_keys_due(200 + 900_000 + 1)
                .unwrap()
                .contains(&(
                    "provider-a".to_string(),
                    Some("key-a".to_string()),
                    Some("gpt-5.5".to_string())
                )),
            "in-flight probe must not be re-enqueued by re-upsert"
        );
        assert!(
            !store
                .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
                .unwrap(),
            "second concurrent probe acquisition must be denied"
        );
    }

    #[test]
    fn failure_count_is_provider_key_shared_across_sessions() {
        let store = V3ProviderHealthStore::default();
        for (index, session_id) in ["session-a", "session-b", "session-b"]
            .into_iter()
            .enumerate()
        {
            let record = store
                .record_provider_failure_in_session(
                    &session(session_id),
                    "provider-a",
                    Some("key-a"),
                    Some("gpt-5.5"),
                    None,
                    100,
                )
                .unwrap();
            if index == 2 {
                assert_eq!(
                    (record.state.as_str(), record.failure_count),
                    ("cooldown", 3)
                );
            } else {
                assert_eq!(record.state, "healthy");
            }
        }
        for (key, available) in [("key-a", false), ("key-b", true)] {
            assert_eq!(
                store
                    .availability_for_session(
                        &session("session-a"),
                        "provider-a",
                        Some(key),
                        Some("gpt-5.5"),
                        101,
                    )
                    .available,
                available
            );
        }
    }

    #[test]
    fn quota_concurrency_and_diagnostics_are_provider_owned_inputs() {
        let store = V3ProviderHealthStore::default();
        store
            .update_quota_state(
                &V3ErrorActionScope::CanonicalModel {
                    provider_id: "provider-a".to_string(),
                    model_id: "gpt-5.5".to_string(),
                },
                0,
                Some(1_000),
            )
            .unwrap();
        assert!(
            !store
                .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("provider-a", Some("key-a"), Some("other-model"), 101)
                .available
        );
        store.update_concurrency_state("provider-b", 2, 2).unwrap();
        assert!(
            !store
                .availability("provider-b", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert!(
            store
                .availability("third", Some("key-a"), Some("gpt-5.5"), 101)
                .available
        );
        assert_eq!(
            explain_provider_health_reasons(
                &store,
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                101,
            ),
            vec!["quota:canonical_model:provider-a:gpt-5.5:exhausted"]
        );
    }
}
