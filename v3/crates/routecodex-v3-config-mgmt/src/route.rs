// feature_id: v3.config_mgmt_route_view
// Route 配置管理视图模型：Port -> Route Pool -> Route Tier -> Provider Member。
// 该视图是 config.v3.toml authoring 的投影/编辑面；V3 runtime 路由语义
// （priority 分层、weight 加权）保持唯一真源，本模块不改变路由算法，
// 只把 targets 数组按 priority 分组呈现为 tier 并原样写回。
use routecodex_v3_config::{
    V3Config02AuthoringParsed, V3RouteGroupAuthoringConfig, V3RoutePoolAuthoringConfig,
    V3RoutePoolMatchAuthoringConfig, V3RoutePoolTargetAuthoringConfig, V3RouteTargetKind,
    V3SelectionPolicy, V3SelectionStrategy, V3ServerAuthoringConfig,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoutePortView {
    pub server_id: String,
    pub port: u16,
    pub bind: String,
    pub enabled: bool,
    pub endpoints: Vec<String>,
    pub routing_group: String,
    pub pools: Vec<RoutePoolView>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoutePoolView {
    pub name: String,
    pub selection_strategy: V3SelectionStrategy,
    pub match_rule: Option<V3RoutePoolMatchAuthoringConfig>,
    pub tiers: Vec<RouteTierView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RouteTierView {
    /// runtime 按该值分层（缺失视为 0）。同值 targets 组成一个 tier。
    pub priority: i32,
    pub members: Vec<RouteMemberView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RouteMemberView {
    pub kind: V3RouteTargetKind,
    pub id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    pub priority: i32,
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RouteGroupView {
    pub group_id: String,
    pub ports: Vec<RoutePortView>,
}

pub fn route_groups_from_authoring(
    authoring: &V3Config02AuthoringParsed,
) -> Vec<RouteGroupView> {
    let mut groups: BTreeMap<String, Vec<RoutePortView>> = BTreeMap::new();
    for (server_id, server) in &authoring.servers {
        groups
            .entry(server.routing_group.clone())
            .or_default()
            .push(port_view_from_authoring(server_id, server, authoring));
    }
    groups
        .into_iter()
        .map(|(group_id, mut ports)| {
            ports.sort_by_key(|port| port.port);
            RouteGroupView { group_id, ports }
        })
        .collect()
}

pub fn port_view_from_authoring(
    server_id: &str,
    server: &V3ServerAuthoringConfig,
    authoring: &V3Config02AuthoringParsed,
) -> RoutePortView {
    let pool_map = authoring
        .route_groups
        .get(&server.routing_group)
        .map(|group| &group.pools)
        .cloned()
        .unwrap_or_default();
    let mut pools: Vec<RoutePoolView> = pool_map
        .iter()
        .map(|(name, pool)| pool_view_from_authoring(name, pool))
        .collect();
    pools.sort_by(|a, b| a.name.cmp(&b.name));
    RoutePortView {
        server_id: server_id.to_string(),
        port: server.port,
        bind: server.bind.clone(),
        enabled: server.enabled,
        endpoints: server.endpoints.clone(),
        routing_group: server.routing_group.clone(),
        pools,
    }
}

pub fn pool_view_from_authoring(
    name: &str,
    pool: &V3RoutePoolAuthoringConfig,
) -> RoutePoolView {
    let mut grouped: BTreeMap<i32, Vec<RouteMemberView>> = BTreeMap::new();
    for target in &pool.targets {
        let priority = target.priority.unwrap_or(0);
        grouped.entry(priority).or_default().push(RouteMemberView {
            kind: target.kind.clone(),
            id: target.id.clone(),
            provider: target.provider.clone(),
            model: target.model.clone(),
            key: target.key.clone(),
            priority,
            weight: target.weight,
        });
    }
    let tiers = grouped
        .into_iter()
        .map(|(priority, members)| RouteTierView { priority, members })
        .collect();
    RoutePoolView {
        name: name.to_string(),
        selection_strategy: pool.selection.strategy.clone(),
        match_rule: pool.match_rule.clone(),
        tiers,
    }
}

/// 把视图写回 authoring：同步 route_groups 中全部 pool targets。
/// 只改写 targets（及 selection/match 若视图携带），不触碰无关字段。
pub fn apply_route_group_view_to_authoring(
    authoring: &mut V3Config02AuthoringParsed,
    group: &RouteGroupView,
) {
    let group_entry = authoring
        .route_groups
        .entry(group.group_id.clone())
        .or_insert_with(|| V3RouteGroupAuthoringConfig {
            pools: BTreeMap::new(),
            features: BTreeMap::new(),
        });
    for port in &group.ports {
        let server = match authoring.servers.get_mut(&port.server_id) {
            Some(server) => server,
            None => continue,
        };
        if server.routing_group != group.group_id {
            continue;
        }
        for pool in &port.pools {
            let pool_entry = group_entry
                .pools
                .entry(pool.name.clone())
                .or_insert_with(|| V3RoutePoolAuthoringConfig {
                    selection: V3SelectionPolicy {
                        strategy: V3SelectionStrategy::Priority,
                    },
                    match_rule: None,
                    targets: Vec::new(),
                    features: BTreeMap::new(),
                });
            pool_entry.selection.strategy = pool.selection_strategy.clone();
            pool_entry.match_rule = pool.match_rule.clone();
            pool_entry.targets = flatten_tiers(&pool.tiers);
        }
    }
}

fn flatten_tiers(tiers: &[RouteTierView]) -> Vec<V3RoutePoolTargetAuthoringConfig> {
    let mut targets = Vec::new();
    for tier in tiers {
        for member in &tier.members {
            targets.push(V3RoutePoolTargetAuthoringConfig {
                kind: member.kind.clone(),
                id: member.id.clone(),
                provider: member.provider.clone(),
                model: member.model.clone(),
                key: member.key.clone(),
                priority: Some(member.priority),
                weight: member.weight,
            });
        }
    }
    targets
}

/// 新建最简 default pool（priority 策略，无 match rule），返回其视图。
pub fn new_default_pool_view(name: &str) -> RoutePoolView {
    RoutePoolView {
        name: name.to_string(),
        selection_strategy: V3SelectionStrategy::Priority,
        match_rule: None,
        tiers: Vec::new(),
    }
}
