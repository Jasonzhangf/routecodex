// feature_id: v3.config_mgmt_route_view
// Route 配置管理视图模型：Port -> Route Pool -> Route Tier -> Provider Member。
// 该视图是 config.toml server-local route authoring 的投影/编辑面；V3 runtime 路由语义
// （priority 分层、weight 加权）保持唯一真源，本模块不改变路由算法，
// 只把 targets 数组按 priority 分组呈现为 tier 并原样写回。
use routecodex_v3_config::{
    V3Config02AuthoringParsed, V3RouteGroupAuthoringConfig, V3RoutePoolAuthoringConfig,
    V3RoutePoolMatchAuthoringConfig, V3RoutePoolTargetAuthoringConfig, V3RouteTargetKind,
    V3SelectionPolicy, V3SelectionStrategy, V3ServerAuthoringConfig,
    V3UserConfig02RoutingSelectionParsed, V3UserRouteMember, V3UserRoutePool,
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserRouteGroupView {
    pub server_id: String,
    pub port: u16,
    pub pools: Vec<UserRoutePoolView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserRoutePoolView {
    pub name: String,
    pub tiers: Vec<UserRouteTierView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserRouteTierView {
    pub members: Vec<UserRouteMemberView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserRouteMemberView {
    #[serde(rename = "use")]
    pub use_ref: String,
    pub weight: Option<u32>,
}

pub fn user_route_groups_from_selection(
    selection: &V3UserConfig02RoutingSelectionParsed,
) -> Vec<UserRouteGroupView> {
    selection
        .servers
        .iter()
        .map(|(server_id, server)| UserRouteGroupView {
            server_id: server_id.clone(),
            port: server.port,
            pools: server
                .routes
                .iter()
                .map(|(name, pool)| UserRoutePoolView {
                    name: name.clone(),
                    tiers: pool
                        .tiers
                        .iter()
                        .map(|tier| UserRouteTierView {
                            members: tier
                                .iter()
                                .map(|member| UserRouteMemberView {
                                    use_ref: member.use_ref().to_string(),
                                    weight: member.weight,
                                })
                                .collect(),
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect()
}

/// 把 user routing 视图写回 selection。
///
/// 视图里出现而 selection 中尚不存在的 pool 按 `new_default_pool_view` 的语义
/// 创建为空 pool（priority 策略、无 match rule、无 tier），再写入视图 tiers；
/// 这样 "新增 provider 并接线" 在只有 default pool 的配置上也可达，而不是
/// 因 `unknown route pool` 直接失败。server 不存在仍然报错（不隐式建 server）。
pub fn apply_user_route_group_view(
    selection: &mut V3UserConfig02RoutingSelectionParsed,
    group: &UserRouteGroupView,
) -> Result<(), String> {
    let server = selection
        .servers
        .get_mut(&group.server_id)
        .ok_or_else(|| format!("unknown server {:?}", group.server_id))?;
    for pool in &group.pools {
        let target = server
            .routes
            .entry(pool.name.clone())
            .or_insert_with(new_default_user_route_pool);
        target.tiers = pool
            .tiers
            .iter()
            .map(|tier| {
                tier.members
                    .iter()
                    .map(|member| {
                        let (provider, model) =
                            member.use_ref.split_once('/').ok_or_else(|| {
                                format!("invalid provider/model {:?}", member.use_ref)
                            })?;
                        Ok(V3UserRouteMember::new(provider, model, member.weight))
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .collect::<Result<Vec<_>, String>>()?;
    }
    Ok(())
}

/// `new_default_pool_view` 在 user routing 侧的等价构造：空 tiers 即默认 priority pool。
/// 这是 user routing 侧 default pool 的唯一构造点。
fn new_default_user_route_pool() -> V3UserRoutePool {
    V3UserRoutePool { tiers: Vec::new() }
}

/// 一次 user routing 成员绑定的结果；所有字段反映写入后的最终状态。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserRouteMemberBinding {
    pub server_id: String,
    pub pool: String,
    pub tier: usize,
    pub use_ref: String,
    pub weight: Option<u32>,
    /// pool 在本次绑定前不存在，由 default pool 语义创建。
    pub pool_created: bool,
    /// tier 下标在本次绑定前不存在，被创建为空 tier。
    pub tier_created: bool,
    /// 同 `use_ref` 成员已存在，本次原地替换了它的 weight。
    pub replaced: bool,
    /// 同 `use_ref` 且 weight 相同的成员已存在：不需要任何写入。
    pub already_bound: bool,
}

/// 把 `use_ref` 成员写入 user routing 的 server/pool/tier。
///
/// - server 不存在：显式报错并列出已知 server id（不隐式建 server）。
/// - pool / tier 不存在：按 default pool 语义创建（`new_default_user_route_pool`
///   是唯一 owner）。
/// - 同 tier 内已有同 `use_ref` 成员：原地替换，不追加重复成员；weight 相同时
///   报告 `already_bound` 且不修改任何内容。
pub fn bind_user_route_member(
    selection: &mut V3UserConfig02RoutingSelectionParsed,
    server_id: &str,
    pool_name: &str,
    tier_index: usize,
    use_ref: &str,
    weight: Option<u32>,
) -> Result<UserRouteMemberBinding, String> {
    let (provider, model) = use_ref
        .split_once('/')
        .ok_or_else(|| format!("invalid provider/model {use_ref:?}"))?;
    if provider.is_empty() || model.is_empty() {
        return Err(format!("invalid provider/model {use_ref:?}"));
    }
    let known_servers = selection
        .servers
        .keys()
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let server = selection
        .servers
        .get_mut(server_id)
        .ok_or_else(|| format!("unknown server {server_id:?}; known servers: {known_servers}"))?;
    let pool_created = !server.routes.contains_key(pool_name);
    let pool = server
        .routes
        .entry(pool_name.to_string())
        .or_insert_with(new_default_user_route_pool);
    let tier_created = pool.tiers.len() <= tier_index;
    while pool.tiers.len() <= tier_index {
        pool.tiers.push(Vec::new());
    }
    let tier = &mut pool.tiers[tier_index];
    let existing = tier.iter().position(|member| member.use_ref() == use_ref);
    let already_bound = existing
        .map(|index| tier[index].weight == weight)
        .unwrap_or(false);
    let replaced = existing.is_some() && !already_bound;
    match existing {
        Some(index) if !already_bound => {
            tier[index] = V3UserRouteMember::new(provider, model, weight);
        }
        Some(_) => {}
        None => tier.push(V3UserRouteMember::new(provider, model, weight)),
    }
    Ok(UserRouteMemberBinding {
        server_id: server_id.to_string(),
        pool: pool_name.to_string(),
        tier: tier_index,
        use_ref: use_ref.to_string(),
        weight,
        pool_created,
        tier_created,
        replaced,
        already_bound,
    })
}

pub fn route_groups_from_authoring(authoring: &V3Config02AuthoringParsed) -> Vec<RouteGroupView> {
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

pub fn pool_view_from_authoring(name: &str, pool: &V3RoutePoolAuthoringConfig) -> RoutePoolView {
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

/// 把视图写回 server-local routes 中全部 pool targets。
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
            compact_route_object: None,
            route_policies: Vec::new(),
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
                    route_object: None,
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
