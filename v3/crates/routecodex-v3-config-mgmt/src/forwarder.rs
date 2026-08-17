// feature_id: v3.config_mgmt_forwarders
// Forwarder 构建与解析：config.v3.toml 的 [forwarders."<id>"] 段视图。
// 直接以 v3-config 的 authoring 类型为视图（不重复建模），提供列表、
// 单条构建（含 targets 生成）与写回 authoring 的编排。
use routecodex_v3_config::{V3Config02AuthoringParsed, V3ForwarderAuthoringConfig};
use std::collections::BTreeMap;

pub fn forwarders_from_authoring(
    authoring: &V3Config02AuthoringParsed,
) -> Vec<(String, V3ForwarderAuthoringConfig)> {
    authoring
        .forwarders
        .iter()
        .map(|(name, config)| (name.clone(), config.clone()))
        .collect()
}

/// 构建或替换一个 forwarder；name 为空时使用 forwarder.model 作为 id。
pub fn upsert_forwarder(
    authoring: &mut V3Config02AuthoringParsed,
    name: &str,
    forwarder: V3ForwarderAuthoringConfig,
) {
    let key = if name.is_empty() {
        forwarder.model.clone()
    } else {
        name.to_string()
    };
    authoring.forwarders.insert(key, forwarder);
}

pub fn remove_forwarder(authoring: &mut V3Config02AuthoringParsed, name: &str) -> bool {
    authoring.forwarders.remove(name).is_some()
}

/// 生成一个带单 target 的最小 forwarder（priority 策略）。
pub fn new_forwarder_with_target(
    model: &str,
    provider: &str,
    provider_model: &str,
    key: Option<&str>,
    priority: i32,
    weight: Option<u32>,
) -> V3ForwarderAuthoringConfig {
    V3ForwarderAuthoringConfig {
        enabled: true,
        model: model.to_string(),
        aliases: Vec::new(),
        selection: routecodex_v3_config::V3SelectionPolicy {
            strategy: routecodex_v3_config::V3SelectionStrategy::Priority,
        },
        targets: vec![routecodex_v3_config::V3ForwarderTargetAuthoringConfig {
            kind: routecodex_v3_config::V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some(provider.to_string()),
            model: Some(provider_model.to_string()),
            key: key.map(str::to_string),
            priority: Some(priority),
            weight,
        }],
        features: BTreeMap::new(),
    }
}

pub fn forwarder_target_providers(
    forwarder: &V3ForwarderAuthoringConfig,
) -> Vec<String> {
    forwarder
        .targets
        .iter()
        .filter_map(|target| target.provider.clone())
        .collect()
}
