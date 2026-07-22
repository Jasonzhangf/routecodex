use routecodex_v3_config::{
    V3Config05ManifestPublished, V3RoutePoolManifest, V3RoutePoolMatchManifest,
    V3RoutePoolTargetManifest, V3RouteTargetKind, V3SelectionStrategy,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RouterRequestFacts {
    pub entry_protocol: String,
    pub client_model: Option<String>,
    pub capabilities: BTreeSet<String>,
    pub input_tokens: u64,
}

impl V3RouterRequestFacts {
    pub fn from_endpoint(endpoint: &str) -> Self {
        Self {
            entry_protocol: protocol_from_endpoint(endpoint),
            client_model: None,
            capabilities: BTreeSet::new(),
            input_tokens: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Router05RequestClassified {
    pub server_id: String,
    pub routing_group_id: String,
    pub endpoint: String,
    pub facts: V3RouterRequestFacts,
}

#[derive(Debug, PartialEq, Eq)]
pub struct V3Router06RoutePoolResolved {
    server_id: String,
    routing_group_id: String,
    facts: V3RouterRequestFacts,
    tiers: Vec<V3Router06SelectionPlanTier>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Router06SelectionPlanTier {
    pool_id: String,
    selection: V3SelectionStrategy,
    targets: Vec<V3RoutePoolTargetManifest>,
}

impl V3Router06RoutePoolResolved {
    pub fn routing_group_id(&self) -> &str {
        &self.routing_group_id
    }

    pub fn tier_count(&self) -> usize {
        self.tiers.len()
    }

    pub fn candidate_count(&self) -> usize {
        self.tiers.iter().map(|tier| tier.targets.len()).sum()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Router07OpaqueTargetHitOnce {
    pub server_id: String,
    pub routing_group_id: String,
    pub pool_id: String,
    pub target_index: usize,
    pub target_kind: V3RouteTargetKind,
    pub target_id: Option<String>,
    pub target_plan: Vec<V3Router07OpaqueTargetPlanEntry>,
    pub request_capabilities: BTreeSet<String>,
    pub hit_count: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Router07OpaqueTargetPlanEntry {
    pub tier_index: usize,
    pub pool_id: String,
    pub target_index: usize,
    pub target_kind: V3RouteTargetKind,
    pub target_id: Option<String>,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum V3VirtualRouterError {
    #[error("server {0} is absent or disabled")]
    ServerUnavailable(String),
    #[error("route group {0} is absent")]
    RouteGroupMissing(String),
    #[error("route group {0} has no explicit default pool")]
    DefaultPoolMissing(String),
    #[error("route group {0} explicit default pool is empty")]
    DefaultPoolEmpty(String),
    #[error("route group {group_id} pool {pool_id} is absent")]
    PoolMissing { group_id: String, pool_id: String },
    #[error("route group {group_id} pool {pool_id} is empty")]
    PoolEmpty { group_id: String, pool_id: String },
    #[error("route group {0} selection plan is empty")]
    SelectionPlanEmpty(String),
    #[error("route group {group_id} has ambiguous matching pools: {pool_ids:?}")]
    AmbiguousPoolMatches {
        group_id: String,
        pool_ids: Vec<String>,
    },
    #[error("route group {group_id} non-default pool {pool_id} has no match declaration")]
    PoolMatchMissing { group_id: String, pool_id: String },
    #[error("routing facts entry protocol is empty or does not match endpoint {0}")]
    InvalidRoutingFacts(String),
}

#[derive(Debug, Clone, Default)]
pub struct V3VirtualRouter {
    cursors: Arc<Mutex<BTreeMap<String, usize>>>,
}

impl V3VirtualRouter {
    pub fn classify_request(
        &self,
        manifest: &V3Config05ManifestPublished,
        server_id: &str,
        endpoint: &str,
    ) -> Result<V3Router05RequestClassified, V3VirtualRouterError> {
        self.classify_request_with_facts(
            manifest,
            server_id,
            endpoint,
            V3RouterRequestFacts::from_endpoint(endpoint),
        )
    }

    pub fn classify_request_with_facts(
        &self,
        manifest: &V3Config05ManifestPublished,
        server_id: &str,
        endpoint: &str,
        facts: V3RouterRequestFacts,
    ) -> Result<V3Router05RequestClassified, V3VirtualRouterError> {
        let endpoint_protocol = protocol_from_endpoint(endpoint);
        if facts.entry_protocol.trim().is_empty() || facts.entry_protocol != endpoint_protocol {
            return Err(V3VirtualRouterError::InvalidRoutingFacts(
                endpoint.to_string(),
            ));
        }
        let server = manifest
            .servers
            .get(server_id)
            .filter(|server| server.enabled)
            .ok_or_else(|| V3VirtualRouterError::ServerUnavailable(server_id.to_string()))?;
        Ok(V3Router05RequestClassified {
            server_id: server.id.clone(),
            routing_group_id: server.routing_group.clone(),
            endpoint: endpoint.to_string(),
            facts,
        })
    }

    pub fn resolve_route_pool_plan(
        &self,
        manifest: &V3Config05ManifestPublished,
        classified: V3Router05RequestClassified,
    ) -> Result<V3Router06RoutePoolResolved, V3VirtualRouterError> {
        let group = manifest
            .route_groups
            .get(&classified.routing_group_id)
            .ok_or_else(|| {
                V3VirtualRouterError::RouteGroupMissing(classified.routing_group_id.clone())
            })?;

        let default_pool = group.pools.get("default").ok_or_else(|| {
            V3VirtualRouterError::DefaultPoolMissing(classified.routing_group_id.clone())
        })?;
        if default_pool.targets.is_empty() {
            return Err(V3VirtualRouterError::DefaultPoolEmpty(
                classified.routing_group_id,
            ));
        }

        let mut matched_pools = Vec::new();
        for (pool_id, pool) in &group.pools {
            if pool_id == "default" {
                continue;
            }
            let match_rule =
                pool.match_rule
                    .as_ref()
                    .ok_or_else(|| V3VirtualRouterError::PoolMatchMissing {
                        group_id: classified.routing_group_id.clone(),
                        pool_id: pool_id.clone(),
                    })?;
            if pool_matches(match_rule, &classified.facts) {
                matched_pools.push((match_rule.precedence, pool_id.clone()));
            }
        }
        matched_pools.sort();
        let best_precedence = matched_pools.first().map(|(precedence, _)| *precedence);
        let best_pool_ids = matched_pools
            .iter()
            .take_while(|(precedence, _)| Some(*precedence) == best_precedence)
            .map(|(_, pool_id)| pool_id.clone())
            .collect::<Vec<_>>();
        if best_pool_ids.len() > 1 {
            return Err(V3VirtualRouterError::AmbiguousPoolMatches {
                group_id: classified.routing_group_id,
                pool_ids: best_pool_ids,
            });
        }

        let mut tiers = Vec::new();
        if let Some(pool_id) = best_pool_ids.first() {
            let pool =
                group
                    .pools
                    .get(pool_id)
                    .ok_or_else(|| V3VirtualRouterError::PoolMissing {
                        group_id: classified.routing_group_id.clone(),
                        pool_id: pool_id.clone(),
                    })?;
            if pool.targets.is_empty() {
                return Err(V3VirtualRouterError::PoolEmpty {
                    group_id: classified.routing_group_id.clone(),
                    pool_id: pool_id.clone(),
                });
            }
            tiers.push(build_plan_tier(pool));
        }
        tiers.push(build_plan_tier(default_pool));

        Ok(V3Router06RoutePoolResolved {
            server_id: classified.server_id,
            routing_group_id: classified.routing_group_id,
            facts: classified.facts,
            tiers,
        })
    }

    pub fn hit_opaque_target_plan_once(
        &self,
        plan: V3Router06RoutePoolResolved,
        deterministic_sample: u64,
    ) -> Result<V3Router07OpaqueTargetHitOnce, V3VirtualRouterError> {
        if plan.tiers.is_empty() {
            return Err(V3VirtualRouterError::SelectionPlanEmpty(
                plan.routing_group_id,
            ));
        }
        let mut target_plan = Vec::new();
        let mut seen = BTreeSet::new();
        for (tier_index, tier) in plan.tiers.iter().enumerate() {
            for target_index in ordered_target_indices(
                &tier.selection,
                &tier.targets,
                deterministic_sample.wrapping_add(tier_index as u64),
                &plan.server_id,
                &plan.routing_group_id,
                &tier.pool_id,
                &self.cursors,
            ) {
                let target = &tier.targets[target_index];
                let semantic_key = semantic_target_key(target);
                if !seen.insert(semantic_key) {
                    continue;
                }
                target_plan.push(V3Router07OpaqueTargetPlanEntry {
                    tier_index,
                    pool_id: tier.pool_id.clone(),
                    target_index,
                    target_kind: target.kind.clone(),
                    target_id: target.id.clone(),
                });
            }
        }
        let first = target_plan.first().ok_or_else(|| {
            V3VirtualRouterError::SelectionPlanEmpty(plan.routing_group_id.clone())
        })?;
        Ok(V3Router07OpaqueTargetHitOnce {
            server_id: plan.server_id,
            routing_group_id: plan.routing_group_id,
            pool_id: first.pool_id.clone(),
            target_index: first.target_index,
            target_kind: first.target_kind.clone(),
            target_id: first.target_id.clone(),
            target_plan,
            request_capabilities: plan.facts.capabilities,
            hit_count: 1,
        })
    }
}

fn build_plan_tier(pool: &V3RoutePoolManifest) -> V3Router06SelectionPlanTier {
    V3Router06SelectionPlanTier {
        pool_id: pool.id.clone(),
        selection: pool.selection.strategy.clone(),
        targets: pool.targets.clone(),
    }
}

fn pool_matches(rule: &V3RoutePoolMatchManifest, facts: &V3RouterRequestFacts) -> bool {
    rule.entry_protocol
        .as_ref()
        .is_none_or(|protocol| protocol == &facts.entry_protocol)
        && (rule.models.is_empty()
            || facts
                .client_model
                .as_ref()
                .is_some_and(|model| rule.models.contains(model)))
        && rule
            .required_capabilities
            .iter()
            .all(|capability| facts.capabilities.contains(capability))
        && rule
            .min_input_tokens
            .is_none_or(|minimum| facts.input_tokens >= minimum)
        && rule
            .max_input_tokens
            .is_none_or(|maximum| facts.input_tokens <= maximum)
}

fn ordered_target_indices(
    strategy: &V3SelectionStrategy,
    targets: &[V3RoutePoolTargetManifest],
    sample: u64,
    server_id: &str,
    routing_group_id: &str,
    pool_id: &str,
    cursors: &Arc<Mutex<BTreeMap<String, usize>>>,
) -> Vec<usize> {
    match strategy {
        V3SelectionStrategy::Priority => {
            let mut order = (0..targets.len()).collect::<Vec<_>>();
            order.sort_by_key(|index| (targets[*index].priority.unwrap_or(0), *index));
            order
        }
        V3SelectionStrategy::Weighted => weighted_order(targets, sample),
        V3SelectionStrategy::RoundRobin => {
            let key = format!("{server_id}:{routing_group_id}:{pool_id}");
            let mut cursor_guard = cursors.lock().expect("router cursor lock");
            let cursor = cursor_guard.entry(key).or_default();
            let start = *cursor % targets.len();
            *cursor = cursor.wrapping_add(1);
            (0..targets.len())
                .map(|offset| (start + offset) % targets.len())
                .collect()
        }
    }
}

fn weighted_order(targets: &[V3RoutePoolTargetManifest], sample: u64) -> Vec<usize> {
    let first = weighted_index(targets, sample);
    let mut remaining = (0..targets.len())
        .filter(|index| *index != first)
        .collect::<Vec<_>>();
    remaining.sort_by_key(|index| (targets[*index].priority.unwrap_or(0), *index));
    let mut order = vec![first];
    order.extend(remaining);
    order
}

fn weighted_index(targets: &[V3RoutePoolTargetManifest], sample: u64) -> usize {
    let total = targets
        .iter()
        .map(|target| u64::from(target.weight.unwrap_or(1)))
        .sum::<u64>();
    let mut point = sample % total;
    for (index, target) in targets.iter().enumerate() {
        let weight = u64::from(target.weight.unwrap_or(1));
        if point < weight {
            return index;
        }
        point -= weight;
    }
    unreachable!("positive compiled weights have a selected bucket")
}

fn semantic_target_key(target: &V3RoutePoolTargetManifest) -> String {
    format!(
        "{:?}|{}|{}|{}|{}",
        target.kind,
        target.id.as_deref().unwrap_or(""),
        target.provider.as_deref().unwrap_or(""),
        target.model.as_deref().unwrap_or(""),
        target.key.as_deref().unwrap_or("")
    )
}

fn protocol_from_endpoint(endpoint: &str) -> String {
    let endpoint = endpoint.trim();
    if endpoint.starts_with("/v1beta/models/") && endpoint.ends_with("/generateContent") {
        return "gemini".to_string();
    }
    match endpoint {
        "/v1/responses" | "responses" => "responses".to_string(),
        "/v1/messages" | "anthropic" => "anthropic".to_string(),
        "/v1beta/models" | "gemini" => "gemini".to_string(),
        "/v1/chat/completions" | "openai_chat" => "openai_chat".to_string(),
        value => value.trim_matches('/').replace('/', "_"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::*;

    fn target(id: &str, priority: i32, weight: u32) -> V3RoutePoolTargetManifest {
        V3RoutePoolTargetManifest {
            kind: V3RouteTargetKind::Forwarder,
            id: Some(id.into()),
            provider: None,
            model: None,
            key: None,
            priority: Some(priority),
            weight: Some(weight),
        }
    }

    fn manifest(strategy: V3SelectionStrategy) -> V3Config05ManifestPublished {
        V3Config05ManifestPublished {
            version: 3,
            hub_v1: None,
            servers: BTreeMap::from([(
                "s".into(),
                V3ServerManifest {
                    id: "s".into(),
                    enabled: true,
                    bind: "127.0.0.1".into(),
                    port: 1,
                    routing_group: "g".into(),
                    endpoints: vec!["responses".into()],
                    features: BTreeMap::new(),
                    execution: None,
                },
            )]),
            providers: BTreeMap::new(),
            forwarders: BTreeMap::new(),
            features: BTreeMap::new(),
            debug: V3DebugManifest {
                log_console: false,
                log_file: None,
                snapshots: false,
                snapshot_stages: None,
                dry_run: false,
                retention: BTreeMap::new(),
            },
            error: V3ErrorManifest {
                policies: BTreeMap::new(),
            },
            route_groups: BTreeMap::from([(
                "g".into(),
                V3RouteGroupManifest {
                    id: "g".into(),
                    features: BTreeMap::new(),
                    pools: BTreeMap::from([
                        (
                            "default".into(),
                            V3RoutePoolManifest {
                                id: "default".into(),
                                selection: V3SelectionPolicy {
                                    strategy: strategy.clone(),
                                },
                                match_rule: None,
                                features: BTreeMap::new(),
                                targets: vec![target("a", 2, 1), target("b", 1, 3)],
                            },
                        ),
                        (
                            "tools".into(),
                            V3RoutePoolManifest {
                                id: "tools".into(),
                                selection: V3SelectionPolicy { strategy },
                                match_rule: Some(V3RoutePoolMatchManifest {
                                    precedence: 10,
                                    entry_protocol: Some("responses".into()),
                                    models: vec!["client-model".into()],
                                    required_capabilities: vec!["tools".into()],
                                    min_input_tokens: Some(1),
                                    max_input_tokens: Some(100),
                                }),
                                features: BTreeMap::new(),
                                targets: vec![target("c", 1, 1), target("a", 2, 1)],
                            },
                        ),
                    ]),
                },
            )]),
        }
    }

    fn matching_facts() -> V3RouterRequestFacts {
        V3RouterRequestFacts {
            entry_protocol: "responses".into(),
            client_model: Some("client-model".into()),
            capabilities: BTreeSet::from(["tools".into()]),
            input_tokens: 10,
        }
    }

    #[test]
    fn resolves_listener_default_and_hits_one_opaque_plan() {
        let router = V3VirtualRouter::default();
        let manifest = manifest(V3SelectionStrategy::Priority);
        let classified = router
            .classify_request(&manifest, "s", "/v1/responses")
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
        assert_eq!(hit.target_id.as_deref(), Some("b"));
        assert_eq!(hit.hit_count, 1);
        assert_eq!(hit.target_plan.len(), 2);
        assert_eq!(hit.target_plan[0].pool_id, "default");
    }

    #[test]
    fn matched_pool_and_default_floor_are_captured_before_one_hit() {
        let router = V3VirtualRouter::default();
        let manifest = manifest(V3SelectionStrategy::Priority);
        let classified = router
            .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
        let ids = hit
            .target_plan
            .iter()
            .map(|entry| entry.target_id.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![Some("c"), Some("a"), Some("b")]);
        assert_eq!(hit.pool_id, "tools");
        assert_eq!(hit.hit_count, 1);
    }

    #[test]
    fn no_match_uses_default_and_only_equal_best_precedence_is_ambiguous() {
        let router = V3VirtualRouter::default();
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: Some("different-model".into()),
                    capabilities: BTreeSet::from(["tools".into()]),
                    input_tokens: 10,
                },
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        assert_eq!(plan.tiers.len(), 1);
        assert_eq!(plan.tiers[0].pool_id, "default");

        let mut duplicate = manifest.route_groups["g"].pools["tools"].clone();
        duplicate.id = "tools-copy".into();
        duplicate.match_rule.as_mut().unwrap().precedence = 20;
        manifest
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .insert("tools-copy".into(), duplicate);
        let classified = router
            .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        assert_eq!(plan.tiers[0].pool_id, "tools");

        manifest
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .get_mut("tools-copy")
            .unwrap()
            .match_rule
            .as_mut()
            .unwrap()
            .precedence = 10;
        let classified = router
            .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
            .unwrap();
        assert_eq!(
            router.resolve_route_pool_plan(&manifest, classified),
            Err(V3VirtualRouterError::AmbiguousPoolMatches {
                group_id: "g".into(),
                pool_ids: vec!["tools".into(), "tools-copy".into()],
            })
        );
    }

    #[test]
    fn entry_protocol_is_a_pool_predicate() {
        let router = V3VirtualRouter::default();
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        manifest
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .get_mut("tools")
            .unwrap()
            .match_rule
            .as_mut()
            .unwrap()
            .entry_protocol = Some("anthropic".into());
        let classified = router
            .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        assert_eq!(plan.tiers.len(), 1);
        assert_eq!(plan.tiers[0].pool_id, "default");
    }

    #[test]
    fn missing_non_default_match_and_invalid_protocol_facts_fail_explicitly() {
        let router = V3VirtualRouter::default();
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        manifest
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .get_mut("tools")
            .unwrap()
            .match_rule = None;
        let classified = router
            .classify_request(&manifest, "s", "/v1/responses")
            .unwrap();
        assert_eq!(
            router.resolve_route_pool_plan(&manifest, classified),
            Err(V3VirtualRouterError::PoolMatchMissing {
                group_id: "g".into(),
                pool_id: "tools".into(),
            })
        );

        assert_eq!(
            router.classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "anthropic".into(),
                    client_model: None,
                    capabilities: BTreeSet::new(),
                    input_tokens: 0,
                },
            ),
            Err(V3VirtualRouterError::InvalidRoutingFacts(
                "/v1/responses".into()
            ))
        );
    }

    #[test]
    fn weighted_and_round_robin_are_deterministic_and_listener_scoped() {
        let router = V3VirtualRouter::default();
        let weighted = manifest(V3SelectionStrategy::Weighted);
        let plan = router
            .resolve_route_pool_plan(
                &weighted,
                router
                    .classify_request(&weighted, "s", "/v1/responses")
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            router
                .hit_opaque_target_plan_once(plan, 1)
                .unwrap()
                .target_id
                .as_deref(),
            Some("b")
        );

        let mut rr = manifest(V3SelectionStrategy::RoundRobin);
        rr.servers.insert(
            "s2".into(),
            V3ServerManifest {
                id: "s2".into(),
                enabled: true,
                bind: "127.0.0.1".into(),
                port: 2,
                routing_group: "g".into(),
                endpoints: vec!["responses".into()],
                features: BTreeMap::new(),
                execution: None,
            },
        );
        let plan = |server_id: &str| {
            router
                .resolve_route_pool_plan(
                    &rr,
                    router
                        .classify_request(&rr, server_id, "/v1/responses")
                        .unwrap(),
                )
                .unwrap()
        };
        assert_eq!(
            router
                .hit_opaque_target_plan_once(plan("s"), 0)
                .unwrap()
                .target_id
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            router
                .hit_opaque_target_plan_once(plan("s2"), 0)
                .unwrap()
                .target_id
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            router
                .hit_opaque_target_plan_once(plan("s"), 0)
                .unwrap()
                .target_id
                .as_deref(),
            Some("b")
        );
    }

    #[test]
    fn missing_or_empty_explicit_default_pool_is_rejected() {
        let router = V3VirtualRouter::default();
        let mut missing = manifest(V3SelectionStrategy::Priority);
        missing
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .remove("default");
        let classified = router
            .classify_request(&missing, "s", "/v1/responses")
            .unwrap();
        assert_eq!(
            router.resolve_route_pool_plan(&missing, classified),
            Err(V3VirtualRouterError::DefaultPoolMissing("g".into()))
        );

        let mut empty = manifest(V3SelectionStrategy::Priority);
        empty
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .get_mut("default")
            .unwrap()
            .targets
            .clear();
        let classified = router
            .classify_request(&empty, "s", "/v1/responses")
            .unwrap();
        assert_eq!(
            router.resolve_route_pool_plan(&empty, classified),
            Err(V3VirtualRouterError::DefaultPoolEmpty("g".into()))
        );
    }
}
