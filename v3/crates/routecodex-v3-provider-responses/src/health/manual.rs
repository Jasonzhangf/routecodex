//! 手动冷却操作（WebUI 手动加入 / 人工探测）的 store 入口。
//!
//! 手动写入直接落在 `V3ProviderHealthState` 的既有 typed 控制面：
//! `auth_key_cooldowns` 与 `provider_cooldown_probes`。没有标记字段、没有
//! 第二份 map，selection 侧与失败驱动冷却完全同形。

use super::persistence::persist_cooldown_state;
use super::{
    V3ProviderCooldown, V3ProviderCooldownProbeState, V3ProviderHealthError, V3ProviderHealthState,
    V3ProviderHealthStore,
};
use crate::provider_cooldown_probe::{
    provider_cooldown_probe_key, resolve_provider_cooldown_probe_key,
    V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS,
};

/// 手动冷却时长上限（24 小时）。这是操作员输入时长的唯一真源。
pub const V3_COOLDOWN_MANUAL_MAX_MS: u64 = 24 * 60 * 60 * 1000;

/// 手动 auth_key 冷却的原因标签，只用于投影展示。
const V3_COOLDOWN_MANUAL_REASON: &str = "manual_cooldown";

fn invalid_manual_cooldown(detail: impl Into<String>) -> V3ProviderHealthError {
    V3ProviderHealthError::InvalidManualCooldown(detail.into())
}

/// 写入手动 probe 冷却，返回实际生效的 `blocked_until_ms`。
///
/// 幂等：已存在同 identity 的 probe 时只把 `blocked_until_ms` 与
/// `next_probe_at_ms` 延长到较晚者，并保留既有的失败计数、档位与单飞标记，
/// 与失败驱动的 `upsert_provider_cooldown_probe_with_interval` 同形。
fn upsert_manual_probe_cooldown(
    state: &mut V3ProviderHealthState,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
    until_ms: u64,
) -> u64 {
    let key = provider_cooldown_probe_key(provider_id, auth_alias, model_id);
    let existing = state.provider_cooldown_probes.get(&key).cloned();
    let configured_max_probe_interval_ms = state
        .failure_policies
        .get(provider_id)
        .and_then(|policy| policy.max_probe_interval_ms);
    let blocked_until_ms = existing
        .as_ref()
        .and_then(|probe| probe.blocked_until_ms)
        .map_or(until_ms, |existing_until| existing_until.max(until_ms));
    let next_probe_at_ms = existing
        .as_ref()
        .and_then(|probe| probe.next_probe_at_ms)
        .map_or(until_ms, |existing_next| existing_next.max(until_ms));
    state.provider_cooldown_probes.insert(
        key,
        V3ProviderCooldownProbeState {
            blocked_until_ms: Some(blocked_until_ms),
            next_probe_at_ms: Some(next_probe_at_ms),
            probe_interval_ms: existing
                .as_ref()
                .map_or(V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS, |probe| {
                    probe.probe_interval_ms
                }),
            max_probe_interval_ms: existing
                .as_ref()
                .and_then(|probe| probe.max_probe_interval_ms)
                .or(configured_max_probe_interval_ms),
            probe_failure_count: existing
                .as_ref()
                .map_or(0, |probe| probe.probe_failure_count),
            long_probe_backoff: existing
                .as_ref()
                .is_some_and(|probe| probe.long_probe_backoff),
            observed_attempts: existing.as_ref().map_or(0, |probe| probe.observed_attempts),
            observed_failures: existing.as_ref().map_or(0, |probe| probe.observed_failures),
            recovery_ewma_ms: existing.as_ref().and_then(|probe| probe.recovery_ewma_ms),
            cooldown_started_at_ms: existing
                .as_ref()
                .map_or(now_ms, |probe| probe.cooldown_started_at_ms),
            probe_in_flight: existing.as_ref().is_some_and(|probe| probe.probe_in_flight),
            probe_model_id: model_id.map(str::to_string),
            rescue_probe_attempted: existing
                .as_ref()
                .is_some_and(|probe| probe.rescue_probe_attempted),
        },
    );
    blocked_until_ms
}

impl V3ProviderHealthStore {
    /// 手动加入冷却（WebUI 手动加入）。
    ///
    /// `kind` 只接受 `"auth_key"` / `"probe"`；其他值（含 `"session"`）返回
    /// `InvalidManualCooldown` 且不写入任何状态。`duration_ms` 超出
    /// `1..=V3_COOLDOWN_MANUAL_MAX_MS` 同样拒绝，不做静默截断。
    /// 返回实际生效的 `until_ms`。
    ///
    /// 幂等：同一 identity 重复加入只把 deadline 延长到较晚者，不产生第二条
    /// 条目（map 以 identity 为 key）。`probe` 在途时保留单飞标记，避免并发
    /// 启动第二个探针。
    ///
    /// `auth_key` 与失败驱动路径一样写入一对状态：`auth_key_cooldowns` 条目
    /// 加上 `(provider_id, auth_alias, None)` 的 probe 条目；后者既是 selection
    /// 实际读取的键，也是唯一被持久化的那一半。
    pub fn add_cooldown_entry(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        kind: &str,
        duration_ms: u64,
        now_ms: u64,
    ) -> Result<u64, V3ProviderHealthError> {
        let provider_id = provider_id.trim();
        if provider_id.is_empty() {
            return Err(invalid_manual_cooldown("provider_id must not be empty"));
        }
        if !matches!(kind, "auth_key" | "probe") {
            return Err(invalid_manual_cooldown(format!(
                "kind {kind:?} is not a manual cooldown kind (auth_key|probe)"
            )));
        }
        if duration_ms == 0 || duration_ms > V3_COOLDOWN_MANUAL_MAX_MS {
            return Err(invalid_manual_cooldown(format!(
                "duration_ms {duration_ms} is outside 1..={V3_COOLDOWN_MANUAL_MAX_MS}"
            )));
        }
        let until_ms = now_ms.saturating_add(duration_ms);
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let applied_until_ms = if kind == "auth_key" {
            // auth_key 冷却的作用域是 provider + auth_alias；失败驱动路径同样
            // 以 model_id=None 建键，selection 只在该键上读取 auth_key 冷却。
            let auth_key = provider_cooldown_probe_key(provider_id, auth_alias, None);
            let until_ms = state
                .auth_key_cooldowns
                .get(&auth_key)
                .and_then(|cooldown| cooldown.until_ms)
                .map_or(until_ms, |existing| existing.max(until_ms));
            upsert_manual_probe_cooldown(
                &mut state,
                provider_id,
                auth_alias,
                None,
                now_ms,
                until_ms,
            );
            state.auth_key_cooldowns.insert(
                auth_key,
                V3ProviderCooldown {
                    reason: V3_COOLDOWN_MANUAL_REASON.to_string(),
                    until_ms: Some(until_ms),
                },
            );
            until_ms
        } else {
            upsert_manual_probe_cooldown(
                &mut state,
                provider_id,
                auth_alias,
                model_id,
                now_ms,
                until_ms,
            )
        };
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(applied_until_ms)
    }

    /// 人工探测（WebUI 人工探测）：把已存在的 probe 提前到 `now_ms` 到期。
    ///
    /// 只改 `next_probe_at_ms`，不动 `blocked_until_ms`；真正执行探针仍是既有
    /// 后台 probe 循环的唯一路径。identity 没有 probe 状态时返回 `Ok(false)`
    /// 且不写入、不持久化。
    pub fn trigger_probe_now(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<bool, V3ProviderHealthError> {
        let mut state = self
            .state
            .write()
            .map_err(|error| V3ProviderHealthError::Poisoned(error.to_string()))?;
        let key = resolve_provider_cooldown_probe_key(
            &state.provider_cooldown_probes,
            provider_id,
            auth_alias,
            model_id,
        );
        let Some(probe_state) = state.provider_cooldown_probes.get_mut(&key) else {
            return Ok(false);
        };
        probe_state.next_probe_at_ms = Some(now_ms);
        persist_cooldown_state(state);
        self.publish_availability_change();
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::V3ProviderAvailabilityReader;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

    fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "routecodex-manual-cooldown-{name}-{}.json",
            std::process::id()
        ))
    }

    #[test]
    fn manual_auth_key_add_is_visible_in_the_cooldown_projection() {
        let store = V3ProviderHealthStore::default();
        let until_ms = store
            .add_cooldown_entry("p", Some("k"), None, "auth_key", 60_000, 1_000)
            .expect("manual auth_key cooldown");
        assert_eq!(until_ms, 61_000);
        let entries = store.cooldown_entries(1_000);
        let entry = entries
            .iter()
            .find(|entry| entry.kind == "auth_key")
            .expect("manual auth_key entry must be projected");
        assert_eq!(entry.provider_id, "p");
        assert_eq!(entry.auth_alias.as_deref(), Some("k"));
        assert_eq!(entry.model_id, None);
        assert_eq!(entry.state, "auth_key_cooldown");
        assert_eq!(entry.until_ms, Some(61_000));
        assert_eq!(entry.remaining_ms, Some(60_000));
        let state = store.state.read().expect("provider health state lock");
        let auth_key =
            crate::provider_cooldown_probe::provider_cooldown_probe_key("p", Some("k"), None);
        assert!(
            state.auth_key_cooldowns.contains_key(&auth_key),
            "manual auth_key add must write the auth_key cooldown map"
        );
        assert!(
            state.provider_cooldown_probes.contains_key(&auth_key),
            "manual auth_key add must write the paired probe entry, like a real failure"
        );
        drop(state);
        assert!(
            !store
                .availability("p", Some("k"), Some("m"), 1_000)
                .available
        );
        // 到点后仍不可用：冷却由「探针成功」而不是墙上时钟解除，配对 probe 条目
        // 仍 pending；这与失败驱动的 auth_key 冷却完全一致（D6 不可区分）。
        let expired_but_probing = store.availability("p", Some("k"), Some("m"), 61_000);
        assert!(
            !expired_but_probing.available,
            "a cooled identity is released by a successful probe, not by wall-clock expiry"
        );
        assert!(expired_but_probing
            .blocked_scopes
            .iter()
            .any(|scope| scope == "provider_cooldown_probe_pending"));
        assert!(
            !expired_but_probing
                .blocked_scopes
                .iter()
                .any(|scope| scope.starts_with("auth_key:")),
            "the auth_key deadline itself has already elapsed"
        );
        // 释放半边：走运行时同一条 probe 完成路径，不手工清 map。
        let permit = store
            .acquire_provider_cooldown_probe("p", Some("k"), None)
            .expect("acquire scheduled probe")
            .expect("the paired probe must be acquirable");
        assert_eq!(permit.provider_id(), "p");
        assert_eq!(permit.auth_alias(), Some("k"));
        assert_eq!(permit.model_id(), None);
        store
            .complete_provider_cooldown_probe_success_at("p", Some("k"), None, 62_000)
            .expect("probe success");
        let released = store.availability("p", Some("k"), Some("m"), 62_000);
        assert!(
            released.available,
            "a successful probe must release the identity: {:?}",
            released.blocked_scopes
        );
        assert!(store.cooldown_entries(62_000).is_empty());
    }

    #[test]
    fn manual_probe_add_is_blocked_until_the_manual_deadline() {
        let store = V3ProviderHealthStore::default();
        let until_ms = store
            .add_cooldown_entry("p", Some("k"), Some("m"), "probe", 30_000, 1_000)
            .expect("manual probe cooldown");
        assert_eq!(until_ms, 31_000);
        let entries = store.cooldown_entries(1_000);
        let entry = entries
            .iter()
            .find(|entry| entry.kind == "probe")
            .expect("manual probe entry must be projected");
        assert_eq!(entry.state, "blocked");
        assert_eq!(entry.until_ms, Some(31_000));
        assert_eq!(entry.remaining_ms, Some(30_000));
        assert_eq!(entry.model_id.as_deref(), Some("m"));
        assert!(
            !store
                .availability("p", Some("k"), Some("m"), 1_000)
                .available
        );
        assert!(store
            .provider_cooldown_probe_keys_due(30_999)
            .expect("due projection")
            .is_empty());
        assert_eq!(
            store.provider_cooldown_probe_keys_due(31_000).unwrap(),
            vec![("p".into(), Some("k".into()), Some("m".into()))]
        );
    }

    #[test]
    fn manual_add_extends_to_the_later_deadline_without_a_second_entry() {
        let store = V3ProviderHealthStore::default();
        assert_eq!(
            store
                .add_cooldown_entry("p", Some("k"), Some("m"), "probe", 10_000, 1_000)
                .unwrap(),
            11_000
        );
        assert_eq!(
            store
                .add_cooldown_entry("p", Some("k"), Some("m"), "probe", 60_000, 2_000)
                .unwrap(),
            62_000
        );
        assert_eq!(
            store
                .add_cooldown_entry("p", Some("k"), Some("m"), "probe", 5_000, 3_000)
                .unwrap(),
            62_000,
            "a shorter manual add must not shorten an existing deadline"
        );
        let entries = store.cooldown_entries(3_000);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.kind == "probe" && entry.provider_id == "p")
                .count(),
            1
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.kind == "probe")
                .and_then(|entry| entry.until_ms),
            Some(62_000)
        );
        assert_eq!(
            store
                .add_cooldown_entry("p", Some("k"), None, "auth_key", 10_000, 1_000)
                .unwrap(),
            11_000
        );
        assert_eq!(
            store
                .add_cooldown_entry("p", Some("k"), None, "auth_key", 60_000, 2_000)
                .unwrap(),
            62_000
        );
        assert_eq!(
            store
                .cooldown_entries(2_000)
                .iter()
                .filter(|entry| entry.kind == "auth_key" && entry.provider_id == "p")
                .count(),
            1
        );
        assert_eq!(
            store
                .cooldown_entries(2_000)
                .iter()
                .filter(|entry| entry.kind == "probe" && entry.model_id.is_none())
                .count(),
            1,
            "the auth_key pair must not stack a second probe entry on re-add"
        );
    }

    #[test]
    fn manual_auth_key_add_writes_the_same_pair_a_failure_writes() {
        let store = V3ProviderHealthStore::default();
        assert_eq!(
            store
                .add_cooldown_entry("p", Some("k"), Some("m"), "auth_key", 90_000, 1_000)
                .unwrap(),
            91_000,
            "auth_key scope ignores the model dimension, like a real failure"
        );
        let state = store.state.read().expect("provider health state lock");
        let auth_key =
            crate::provider_cooldown_probe::provider_cooldown_probe_key("p", Some("k"), None);
        assert!(state.auth_key_cooldowns.contains_key(&auth_key));
        let probe = state
            .provider_cooldown_probes
            .get(&auth_key)
            .expect("paired probe entry");
        assert_eq!(probe.blocked_until_ms, Some(91_000));
        assert_eq!(probe.next_probe_at_ms, Some(91_000));
        assert_eq!(
            probe.probe_interval_ms,
            V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS
        );
        assert!(!probe.probe_in_flight);
        assert_eq!(probe.probe_model_id, None);
        drop(state);
        assert!(
            !store
                .availability("p", Some("k"), Some("other-model"), 1_000)
                .available
        );
        assert_eq!(
            store.provider_cooldown_probe_keys_due(91_000).unwrap(),
            vec![("p".into(), Some("k".into()), None)]
        );
    }

    #[test]
    fn manual_probe_now_makes_the_existing_probe_due_without_touching_the_deadline() {
        let store = V3ProviderHealthStore::default();
        store
            .add_cooldown_entry("p", Some("k"), Some("m"), "probe", 600_000, 1_000)
            .unwrap();
        assert!(store
            .provider_cooldown_probe_keys_due(1_000)
            .unwrap()
            .is_empty());
        assert!(store
            .trigger_probe_now("p", Some("k"), Some("m"), 2_000)
            .unwrap());
        assert_eq!(
            store
                .provider_cooldown_probe_next_deadline_ms("p", Some("k"), Some("m"))
                .unwrap(),
            Some(2_000)
        );
        assert_eq!(
            store.provider_cooldown_probe_keys_due(2_000).unwrap(),
            vec![("p".into(), Some("k".into()), Some("m".into()))]
        );
        let entry = store
            .cooldown_entries(2_000)
            .into_iter()
            .find(|entry| entry.kind == "probe")
            .expect("probe entry");
        assert_eq!(
            entry.until_ms,
            Some(601_000),
            "manual probe must leave blocked_until_ms intact"
        );
    }

    #[test]
    fn manual_probe_now_on_unknown_identity_changes_nothing() {
        let store = V3ProviderHealthStore::default();
        store
            .add_cooldown_entry("p", Some("k"), Some("m"), "probe", 600_000, 1_000)
            .unwrap();
        let before = store.cooldown_entries(1_000);
        assert!(!store
            .trigger_probe_now("other", Some("k"), Some("m"), 2_000)
            .unwrap());
        assert!(!store
            .trigger_probe_now("p", Some("k"), None, 2_000)
            .unwrap());
        let after = store.cooldown_entries(1_000);
        assert_eq!(before.len(), after.len());
        assert_eq!(before[0].until_ms, after[0].until_ms);
        assert_eq!(
            store
                .provider_cooldown_probe_next_deadline_ms("p", Some("k"), Some("m"))
                .unwrap(),
            Some(601_000)
        );
    }

    #[test]
    fn manual_add_rejects_out_of_range_duration_and_unknown_kind() {
        let store = V3ProviderHealthStore::default();
        assert!(matches!(
            store.add_cooldown_entry("p", Some("k"), Some("m"), "probe", 0, 1_000),
            Err(V3ProviderHealthError::InvalidManualCooldown(_))
        ));
        assert!(matches!(
            store.add_cooldown_entry(
                "p",
                Some("k"),
                Some("m"),
                "probe",
                V3_COOLDOWN_MANUAL_MAX_MS + 1,
                1_000
            ),
            Err(V3ProviderHealthError::InvalidManualCooldown(_))
        ));
        assert!(matches!(
            store.add_cooldown_entry("p", Some("k"), Some("m"), "session", 1_000, 1_000),
            Err(V3ProviderHealthError::InvalidManualCooldown(_))
        ));
        assert!(matches!(
            store.add_cooldown_entry("  ", Some("k"), Some("m"), "probe", 1_000, 1_000),
            Err(V3ProviderHealthError::InvalidManualCooldown(_))
        ));
        assert!(store.cooldown_entries(1_000).is_empty());
        assert!(store
            .provider_cooldown_probe_keys_due(1_000)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .add_cooldown_entry(
                    "p",
                    Some("k"),
                    Some("m"),
                    "probe",
                    V3_COOLDOWN_MANUAL_MAX_MS,
                    1_000
                )
                .unwrap(),
            1_000 + V3_COOLDOWN_MANUAL_MAX_MS
        );
    }

    #[test]
    fn manual_probe_state_survives_a_persistence_reload() {
        let path = temp_path("reload");
        let store =
            V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest(), path.clone());
        store
            .add_cooldown_entry("p", Some("k"), Some("m"), "probe", 120_000, 1_000)
            .unwrap();
        store
            .flush_persistence()
            .expect("manual probe state must be durable before restart");
        drop(store);

        let restored =
            V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest(), path);
        let entry = restored
            .cooldown_entries(2_000)
            .into_iter()
            .find(|entry| entry.kind == "probe")
            .expect("manual probe state must be restored");
        assert_eq!(entry.until_ms, Some(121_000));
        assert_eq!(entry.model_id.as_deref(), Some("m"));
        assert!(
            !restored
                .availability("p", Some("k"), Some("m"), 2_000)
                .available
        );
        // Restart re-arms the probe schedule for every persisted cooldown
        // (startup probe), exactly as it does for a failure-driven cooldown;
        // the manual deadline itself is what must survive.
        assert_eq!(
            restored
                .provider_cooldown_probe_next_deadline_ms("p", Some("k"), Some("m"))
                .unwrap(),
            Some(0)
        );
        assert_eq!(
            restored.provider_cooldown_probe_keys_due(0).unwrap(),
            vec![("p".into(), Some("k".into()), Some("m".into()))]
        );
    }

    #[test]
    fn manual_auth_key_state_survives_a_persistence_reload_through_its_probe_pair() {
        let path = temp_path("auth-key-reload");
        let store =
            V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest(), path.clone());
        store
            .add_cooldown_entry("p", Some("k"), None, "auth_key", 120_000, 1_000)
            .unwrap();
        store
            .flush_persistence()
            .expect("manual auth_key pair must be durable before restart");
        drop(store);

        let restored =
            V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest(), path);
        assert!(
            !restored
                .availability("p", Some("k"), Some("m"), 2_000)
                .available,
            "the persisted probe half of the auth_key pair must keep blocking after restart"
        );
        let probe = restored
            .cooldown_entries(2_000)
            .into_iter()
            .find(|entry| entry.kind == "probe")
            .expect("auth_key pair must be restored through its probe entry");
        assert_eq!(probe.model_id, None);
        assert_eq!(probe.until_ms, Some(121_000));
        assert_eq!(
            restored.provider_cooldown_probe_keys_due(0).unwrap(),
            vec![("p".into(), Some("k".into()), None)]
        );
    }
}
