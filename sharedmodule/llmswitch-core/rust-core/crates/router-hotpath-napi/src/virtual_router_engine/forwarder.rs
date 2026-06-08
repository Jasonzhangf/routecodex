//! ProviderForwarder — Rust 真源
//!
//! Forwarder 把同 protocol+model 的 N 个 provider 折叠为 1 个 logical target。
//! 解析 100% 在 `select_with_forwarder_resolution` 完成，host 永远只看到 real `provider_key`。
//!
//! 设计约束（硬护栏）：
//! 1. forwarder id 仅做命名空间（`fwd.` 前缀）；**禁止**按 `split(".")` 推算 model
//! 2. 不接管 WindsurfAccountPool；sticky map 独立持有
//! 3. 全 disabled → fail-fast（`ERR_FORWARDER_NO_AVAILABLE_TARGET`）
//! 4. 不修改 build_target（forwarder 解析发生在 select 阶段）

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use super::load_balancer::RouteLoadBalancer;

pub(crate) const FORWARDER_ID_PREFIX: &str = "fwd.";
pub(crate) const ERR_FORWARDER_NO_AVAILABLE_TARGET: &str = "ERR_FORWARDER_NO_AVAILABLE_TARGET";

/// 单个 forwarder target —— **不持有** transport/auth/compat 字段（纯索引）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForwarderTarget {
    /// real provider_key（不带 fwd. 前缀）
    pub provider_key: String,
    /// weighted 模式权重
    pub weight: Option<i64>,
    /// priority 模式优先级（数字小者优先）
    pub priority: Option<i64>,
    pub disabled: bool,
}

/// Sticky key 模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StickyKey {
    None,
    Request,
    Session,
}

/// Resolution 模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ResolutionMode {
    ModelFirst,
    ProviderFirst,
}

/// Forwarder 策略
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ForwarderStrategy {
    RoundRobin,
    Priority,
    Weighted,
}

/// Forwarder entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForwarderEntry {
    pub forwarder_id: String,
    pub protocol: String,
    pub model_id: String,
    pub resolution_mode: ResolutionMode,
    pub strategy: ForwarderStrategy,
    pub targets: Vec<ForwarderTarget>,
    pub weights: Option<HashMap<String, i64>>,
    pub sticky_key: StickyKey,
}

/// Forwarder 注册表
#[derive(Debug, Default, Clone)]
pub(crate) struct ForwarderRegistry {
    entries: HashMap<String, ForwarderEntry>,
    by_model: HashMap<(String, String), String>, // (protocol, model) -> forwarder_id
    by_provider: HashMap<String, Vec<String>>,   // provider_key -> [forwarder_id]
    /// Sticky map: (session_id, forwarder_id) -> real_provider_key
    sticky_sessions: HashMap<(String, String), String>,
}

impl ForwarderRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 校验 forwarder id 前缀
    pub(crate) fn is_forwarder_id(id: &str) -> bool {
        id.starts_with(FORWARDER_ID_PREFIX)
    }

    /// 从 forwarder id 中提取纯 id 部分（**仅做 prefix 校验，不做语义解析**）
    /// 调用方需要从显式 `id` 字段拿到完整字符串，**禁止** split(".")
    pub(crate) fn validate_id(id: &str) -> Result<(), String> {
        if !Self::is_forwarder_id(id) {
            return Err(format!(
                "forwarder id '{}' must start with '{}'",
                id, FORWARDER_ID_PREFIX
            ));
        }
        if id.len() <= FORWARDER_ID_PREFIX.len() {
            return Err(format!("forwarder id '{}' is empty after prefix", id));
        }
        Ok(())
    }

    /// 加载 forwarder 配置
    pub(crate) fn load(
        &mut self,
        forwarders: &Map<String, Value>,
        provider_keys: &HashSet<String>,
    ) -> Result<(), String> {
        self.entries.clear();
        self.by_model.clear();
        self.by_provider.clear();
        // sticky_sessions 保留（runtime 状态不重置）

        let mut seen_model: HashMap<(String, String), String> = HashMap::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        for (id, value) in forwarders.iter() {
            Self::validate_id(id)?;
            if !seen_ids.insert(id.clone()) {
                return Err(format!("duplicate forwarder id '{}'", id));
            }
            let entry: ForwarderEntry = serde_json::from_value(value.clone())
                .map_err(|e| format!("forwarder '{}' parse error: {}", id, e))?;

            if entry.protocol.is_empty() {
                return Err(format!("forwarder '{}' missing protocol", id));
            }
            if entry.model_id.is_empty() {
                return Err(format!("forwarder '{}' missing model_id", id));
            }
            if entry.targets.is_empty() {
                return Err(format!("forwarder '{}' has no targets", id));
            }

            // 校验 targets 引用真实存在的 provider
            for target in &entry.targets {
                if !provider_keys.contains(&target.provider_key) {
                    return Err(format!(
                        "forwarder '{}' references unknown provider_key '{}'",
                        id, target.provider_key
                    ));
                }
                if target.disabled {
                    continue;
                }
                if entry.resolution_mode == ResolutionMode::ProviderFirst {
                    self.by_provider
                        .entry(target.provider_key.clone())
                        .or_default()
                        .push(id.clone());
                }
            }

            // model 唯一性校验（同 (protocol, model) 不允许多 forwarder）
            let model_key = (entry.protocol.clone(), entry.model_id.clone());
            if let Some(existing_id) = seen_model.get(&model_key) {
                return Err(format!(
                    "duplicate forwarder for (protocol='{}', model='{}'): existing='{}', new='{}'",
                    entry.protocol, entry.model_id, existing_id, id
                ));
            }
            seen_model.insert(model_key, id.clone());

            self.by_model
                .insert((entry.protocol.clone(), entry.model_id.clone()), id.clone());
            self.entries.insert(id.clone(), entry);
        }
        Ok(())
    }

    pub(crate) fn get(&self, forwarder_id: &str) -> Option<&ForwarderEntry> {
        self.entries.get(forwarder_id)
    }

    pub(crate) fn list_ids(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    pub(crate) fn list_entries(&self) -> Vec<ForwarderEntry> {
        let mut entries = self.entries.values().cloned().collect::<Vec<_>>();
        entries.sort_by(|left, right| left.forwarder_id.cmp(&right.forwarder_id));
        entries
    }

    /// model-first 解析
    pub(crate) fn resolve_by_model(&self, protocol: &str, model: &str) -> Option<&ForwarderEntry> {
        let id = self
            .by_model
            .get(&(protocol.to_string(), model.to_string()))?;
        self.entries.get(id)
    }

    /// provider-first 解析（provider_key -> entry 列表中第一个 model 匹配）
    pub(crate) fn resolve_by_provider(
        &self,
        provider_key: &str,
        model: Option<&str>,
    ) -> Option<&ForwarderEntry> {
        let ids = self.by_provider.get(provider_key)?;
        for id in ids {
            if let Some(entry) = self.entries.get(id) {
                if let Some(m) = model {
                    if entry.model_id != m {
                        continue;
                    }
                }
                return Some(entry);
            }
        }
        None
    }

    /// 在 forwarder 内选 1 个 real provider_key
    /// 流程：availability_check 过滤 → RouteLoadBalancer::select 复用 → sticky 写回
    /// 全不可用 → 返回 `Err(ERR_FORWARDER_NO_AVAILABLE_TARGET)`
    pub(crate) fn select(
        &mut self,
        forwarder_id: &str,
        load_balancer: &mut RouteLoadBalancer,
        availability_check: impl Fn(&str) -> bool,
        session_id: Option<&str>,
    ) -> Result<String, String> {
        let entry = self
            .entries
            .get(forwarder_id)
            .ok_or_else(|| format!("unknown forwarder id '{}'", forwarder_id))?
            .clone();

        // 1. sticky 命中
        if entry.sticky_key == StickyKey::Session {
            if let Some(sid) = session_id {
                let key = (sid.to_string(), forwarder_id.to_string());
                if let Some(pinned) = self.sticky_sessions.get(&key) {
                    if availability_check(pinned) {
                        return Ok(pinned.clone());
                    }
                    // pinned 不再可用，删除 sticky
                    self.sticky_sessions.remove(&key);
                }
            }
        }

        // 2. 收集 enabled targets
        let enabled_targets: Vec<String> = entry
            .targets
            .iter()
            .filter(|t| !t.disabled)
            .map(|t| t.provider_key.clone())
            .collect();
        if enabled_targets.is_empty() {
            return Err(ERR_FORWARDER_NO_AVAILABLE_TARGET.to_string());
        }

        // 3. RouteLoadBalancer::select 复用（weighted/priority/round-robin）
        let strategy_override = match entry.strategy {
            ForwarderStrategy::Weighted => Some("weighted"),
            ForwarderStrategy::RoundRobin => Some("round-robin"),
            ForwarderStrategy::Priority => Some("priority"),
        };
        // weights 透传（target.weight 优先；缺失时使用 entry.weights）
        let weights = build_forwarder_weights(&entry);
        let state_key = format!("forwarder:{}", forwarder_id);

        let selected = load_balancer
            .select(
                &state_key,
                &enabled_targets,
                weights.as_ref(),
                &availability_check,
                strategy_override,
            )
            .ok_or_else(|| ERR_FORWARDER_NO_AVAILABLE_TARGET.to_string())?;

        // 4. sticky 写回
        if entry.sticky_key == StickyKey::Session {
            if let Some(sid) = session_id {
                self.sticky_sessions.insert(
                    (sid.to_string(), forwarder_id.to_string()),
                    selected.clone(),
                );
            }
        }
        Ok(selected)
    }

    /// 清除 sticky（仅测试用 / health failure 时调用）
    pub(crate) fn clear_sticky(&mut self, session_id: &str, forwarder_id: &str) {
        self.sticky_sessions
            .remove(&(session_id.to_string(), forwarder_id.to_string()));
    }

    /// sticky 条目数（仅测试 / 观测用）
    pub(crate) fn sticky_count(&self) -> usize {
        self.sticky_sessions.len()
    }
}

/// 构造 RouteLoadBalancer::select 需要的 weights map
fn build_forwarder_weights(entry: &ForwarderEntry) -> Option<HashMap<String, i64>> {
    match entry.strategy {
        ForwarderStrategy::Weighted => {
            let mut weights: HashMap<String, i64> = entry.weights.clone().unwrap_or_default();
            for target in &entry.targets {
                if let Some(w) = target.weight {
                    weights.insert(target.provider_key.clone(), w.max(1));
                }
            }
            if weights.is_empty() {
                None
            } else {
                Some(weights)
            }
        }
        ForwarderStrategy::Priority => {
            // priority 数字小者优先；转换为 weight = max_priority - priority + 1
            let priorities: Vec<i64> = entry.targets.iter().filter_map(|t| t.priority).collect();
            if priorities.is_empty() {
                return entry.weights.clone();
            }
            let max_priority = *priorities.iter().max().unwrap_or(&1);
            let mut weights: HashMap<String, i64> = HashMap::new();
            for target in &entry.targets {
                let p = target.priority.unwrap_or(max_priority);
                let w = (max_priority - p + 1).max(1);
                weights.insert(target.provider_key.clone(), w);
            }
            Some(weights)
        }
        ForwarderStrategy::RoundRobin => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::load_balancer::RouteLoadBalancer;

    fn make_providers() -> HashSet<String> {
        let mut s = HashSet::new();
        s.insert("openai-prod-1.key1".to_string());
        s.insert("openai-prod-2.key1".to_string());
        s.insert("azure-gpt4o.key1".to_string());
        s.insert("openrouter-gpt4.key1".to_string());
        s
    }

    fn make_entry(
        id: &str,
        protocol: &str,
        model: &str,
        strategy: ForwarderStrategy,
        targets: Vec<(&str, Option<i64>, Option<i64>, bool)>,
    ) -> (String, Value) {
        let entry = serde_json::json!({
            "forwarderId": id,
            "protocol": protocol,
            "modelId": model,
            "resolutionMode": "model-first",
            "strategy": match strategy {
                ForwarderStrategy::Weighted => "weighted",
                ForwarderStrategy::RoundRobin => "round-robin",
                ForwarderStrategy::Priority => "priority",
            },
            "targets": targets.iter().map(|(pk, w, p, d)| {
                serde_json::json!({
                    "providerKey": pk,
                    "weight": w,
                    "priority": p,
                    "disabled": d,
                })
            }).collect::<Vec<_>>(),
            "stickyKey": "none",
        });
        (id.to_string(), entry)
    }

    #[test]
    fn validate_id_rejects_non_fwd_prefix() {
        assert!(ForwarderRegistry::validate_id("openai.key1").is_err());
        assert!(ForwarderRegistry::validate_id("fwd.").is_err());
        assert!(ForwarderRegistry::validate_id("fwd.openai.gpt-4o").is_ok());
    }

    #[test]
    fn load_registers_single_forwarder() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::Weighted,
            vec![("openai-prod-1.key1", Some(5), None, false)],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        assert!(reg.get("fwd.openai.gpt-4o").is_some());
    }

    #[test]
    fn load_rejects_unknown_provider_key() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::Weighted,
            vec![("unknown.key1", Some(5), None, false)],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        let result = reg.load(&fwd, &providers);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown provider_key"));
    }

    #[test]
    fn load_rejects_duplicate_id() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::RoundRobin,
            vec![("openai-prod-1.key1", None, None, false)],
        );
        fwd.insert(id.clone(), value.clone());
        // Same id cannot appear twice in a JSON map, so simulate via different ids but same model
        let mut fwd2 = serde_json::Map::new();
        let (id2, value2) = make_entry(
            "fwd.openai.gpt-4o-dup",
            "openai",
            "gpt-4o",
            ForwarderStrategy::RoundRobin,
            vec![("openai-prod-2.key1", None, None, false)],
        );
        fwd2.insert(id, value);
        fwd2.insert(id2, value2);
        let providers = make_providers();
        let result = reg.load(&fwd2, &providers);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("duplicate forwarder"));
    }

    #[test]
    fn load_rejects_empty_targets() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let entry = serde_json::json!({
            "forwarderId": "fwd.openai.gpt-4o",
            "protocol": "openai",
            "modelId": "gpt-4o",
            "resolutionMode": "model-first",
            "strategy": "weighted",
            "targets": [],
            "stickyKey": "none",
        });
        fwd.insert("fwd.openai.gpt-4o".to_string(), entry);
        let providers = make_providers();
        let result = reg.load(&fwd, &providers);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_by_model_works() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::Weighted,
            vec![("openai-prod-1.key1", Some(5), None, false)],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let entry = reg.resolve_by_model("openai", "gpt-4o");
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().protocol, "openai");
    }

    #[test]
    fn resolve_by_model_with_dotted_model_does_not_split_semantics() {
        // P0-2: fwd id opaque; model 字段显式提供
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let entry = serde_json::json!({
            "forwarderId": "fwd.openai.gpt-4.1",
            "protocol": "openai",
            "modelId": "gpt-4.1",
            "resolutionMode": "model-first",
            "strategy": "round-robin",
            "targets": [{"providerKey": "openai-prod-1.key1", "weight": null, "priority": null, "disabled": false}],
            "stickyKey": "none",
        });
        fwd.insert("fwd.openai.gpt-4.1".to_string(), entry);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        // resolve should match the EXPLICIT modelId "gpt-4.1", not any inferred split
        let resolved = reg.resolve_by_model("openai", "gpt-4.1");
        assert!(resolved.is_some());
        assert_eq!(resolved.unwrap().model_id, "gpt-4.1");
    }

    #[test]
    fn select_returns_real_provider_key() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::RoundRobin,
            vec![
                ("openai-prod-1.key1", None, None, false),
                ("openai-prod-2.key1", None, None, false),
                ("azure-gpt4o.key1", None, None, false),
            ],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        let result = reg.select("fwd.openai.gpt-4o", &mut lb, |_| true, None);
        assert!(result.is_ok());
        let key = result.unwrap();
        // 必须是 real provider_key，不含 fwd. 前缀
        assert!(!key.starts_with("fwd."));
        assert!(providers.contains(&key));
    }

    #[test]
    fn select_all_disabled_returns_error() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::RoundRobin,
            vec![
                ("openai-prod-1.key1", None, None, true),
                ("openai-prod-2.key1", None, None, true),
            ],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        let result = reg.select("fwd.openai.gpt-4o", &mut lb, |_| true, None);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), ERR_FORWARDER_NO_AVAILABLE_TARGET);
    }

    #[test]
    fn select_availability_check_filters() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::RoundRobin,
            vec![
                ("openai-prod-1.key1", None, None, false),
                ("openai-prod-2.key1", None, None, false),
            ],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        // availability check 仅允许 openai-prod-1
        let result = reg.select(
            "fwd.openai.gpt-4o",
            &mut lb,
            |k| k == "openai-prod-1.key1",
            None,
        );
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "openai-prod-1.key1");
    }

    #[test]
    fn select_weighted_distribution() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::Weighted,
            vec![
                ("openai-prod-1.key1", Some(5), None, false),
                ("openai-prod-2.key1", Some(3), None, false),
                ("azure-gpt4o.key1", Some(2), None, false),
            ],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        let mut counts: HashMap<String, i64> = HashMap::new();
        for _ in 0..30 {
            let key = reg
                .select("fwd.openai.gpt-4o", &mut lb, |_| true, None)
                .unwrap();
            *counts.entry(key).or_insert(0) += 1;
        }
        // weighted 5:3:2 → openai-prod-1 占多数
        assert!(
            counts.get("openai-prod-1.key1").copied().unwrap_or(0)
                >= counts.get("azure-gpt4o.key1").copied().unwrap_or(0)
        );
        assert!(
            counts.get("openai-prod-2.key1").copied().unwrap_or(0)
                >= counts.get("azure-gpt4o.key1").copied().unwrap_or(0)
        );
    }

    #[test]
    fn select_priority_picks_lowest_priority_first() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let (id, value) = make_entry(
            "fwd.openai.gpt-4o",
            "openai",
            "gpt-4o",
            ForwarderStrategy::Priority,
            vec![
                ("openai-prod-1.key1", None, Some(10), false),
                ("openai-prod-2.key1", None, Some(1), false),
                ("azure-gpt4o.key1", None, Some(5), false),
            ],
        );
        fwd.insert(id, value);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        let result = reg.select("fwd.openai.gpt-4o", &mut lb, |_| true, None);
        assert!(result.is_ok());
        // priority 1 最低，最高优先级
        assert_eq!(result.unwrap(), "openai-prod-2.key1");
    }

    #[test]
    fn sticky_session_pins_same_target() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let entry = serde_json::json!({
            "forwarderId": "fwd.openai.gpt-4o",
            "protocol": "openai",
            "modelId": "gpt-4o",
            "resolutionMode": "model-first",
            "strategy": "round-robin",
            "targets": [
                {"providerKey": "openai-prod-1.key1", "weight": null, "priority": null, "disabled": false},
                {"providerKey": "openai-prod-2.key1", "weight": null, "priority": null, "disabled": false},
            ],
            "stickyKey": "session",
        });
        fwd.insert("fwd.openai.gpt-4o".to_string(), entry);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        let first = reg
            .select("fwd.openai.gpt-4o", &mut lb, |_| true, Some("session-A"))
            .unwrap();
        // 同 session 5 次都返回相同 key
        for _ in 0..5 {
            let again = reg
                .select("fwd.openai.gpt-4o", &mut lb, |_| true, Some("session-A"))
                .unwrap();
            assert_eq!(again, first);
        }
        // 不同 session 允许不同
        let _ = reg
            .select("fwd.openai.gpt-4o", &mut lb, |_| true, Some("session-B"))
            .unwrap();
        assert_eq!(reg.sticky_count(), 2);
    }

    #[test]
    fn sticky_invalidated_when_pinned_unavailable() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let entry = serde_json::json!({
            "forwarderId": "fwd.openai.gpt-4o",
            "protocol": "openai",
            "modelId": "gpt-4o",
            "resolutionMode": "model-first",
            "strategy": "round-robin",
            "targets": [
                {"providerKey": "openai-prod-1.key1", "weight": null, "priority": null, "disabled": false},
                {"providerKey": "openai-prod-2.key1", "weight": null, "priority": null, "disabled": false},
            ],
            "stickyKey": "session",
        });
        fwd.insert("fwd.openai.gpt-4o".to_string(), entry);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        // 第一次：可全选
        let first = reg
            .select("fwd.openai.gpt-4o", &mut lb, |_| true, Some("session-A"))
            .unwrap();
        // 第二次：first 已不可用 → 应 fallback
        let next = reg
            .select(
                "fwd.openai.gpt-4o",
                &mut lb,
                |k| k != first,
                Some("session-A"),
            )
            .unwrap();
        assert_ne!(first, next);
    }

    #[test]
    fn resolve_by_provider_matches_model() {
        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        let entry = serde_json::json!({
            "forwarderId": "fwd.openai.gpt-4o",
            "protocol": "openai",
            "modelId": "gpt-4o",
            "resolutionMode": "provider-first",
            "strategy": "round-robin",
            "targets": [
                {"providerKey": "openai-prod-1.key1", "weight": null, "priority": null, "disabled": false},
            ],
            "stickyKey": "none",
        });
        fwd.insert("fwd.openai.gpt-4o".to_string(), entry);
        let providers = make_providers();
        reg.load(&fwd, &providers).expect("load");
        let resolved = reg.resolve_by_provider("openai-prod-1.key1", Some("gpt-4o"));
        assert!(resolved.is_some());
        let resolved_wrong = reg.resolve_by_provider("openai-prod-1.key1", Some("gpt-5"));
        assert!(resolved_wrong.is_none());
    }
}
