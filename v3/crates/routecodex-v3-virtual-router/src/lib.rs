use routecodex_v3_config::{
    V3Config05ManifestPublished, V3RoutePoolManifest, V3RoutePoolTargetManifest, V3RouteTargetKind,
    V3SelectionStrategy,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Router05RequestClassified {
    pub server_id: String,
    pub routing_group_id: String,
    pub endpoint: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct V3Router06RoutePoolResolved {
    pub server_id: String,
    pub routing_group_id: String,
    pub pool_id: String,
    pub selection: V3SelectionStrategy,
    pub targets: Vec<V3RoutePoolTargetManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Router07OpaqueTargetHitOnce {
    pub routing_group_id: String,
    pub pool_id: String,
    pub target_index: usize,
    pub target_kind: V3RouteTargetKind,
    pub target_id: Option<String>,
    pub hit_count: u8,
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
        let server = manifest
            .servers
            .get(server_id)
            .filter(|server| server.enabled)
            .ok_or_else(|| V3VirtualRouterError::ServerUnavailable(server_id.to_string()))?;
        Ok(V3Router05RequestClassified {
            server_id: server.id.clone(),
            routing_group_id: server.routing_group.clone(),
            endpoint: endpoint.to_string(),
        })
    }

    pub fn resolve_default_pool(
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
        let pool = group.pools.get("default").ok_or_else(|| {
            V3VirtualRouterError::DefaultPoolMissing(classified.routing_group_id.clone())
        })?;
        if pool.targets.is_empty() {
            return Err(V3VirtualRouterError::DefaultPoolEmpty(
                classified.routing_group_id,
            ));
        }
        Ok(build_pool(classified, pool))
    }

    pub fn hit_opaque_target_once(
        &self,
        pool: V3Router06RoutePoolResolved,
        deterministic_sample: u64,
    ) -> Result<V3Router07OpaqueTargetHitOnce, V3VirtualRouterError> {
        let target_index = match pool.selection {
            V3SelectionStrategy::Priority => pool
                .targets
                .iter()
                .enumerate()
                .min_by_key(|(index, target)| (target.priority.unwrap_or(0), *index))
                .map(|(index, _)| index)
                .expect("non-empty pool"),
            V3SelectionStrategy::Weighted => weighted_index(&pool.targets, deterministic_sample),
            V3SelectionStrategy::RoundRobin => {
                let key = format!("{}:{}", pool.routing_group_id, pool.pool_id);
                let mut cursors = self.cursors.lock().expect("router cursor lock");
                let cursor = cursors.entry(key).or_default();
                let index = *cursor % pool.targets.len();
                *cursor = cursor.wrapping_add(1);
                index
            }
        };
        let target = &pool.targets[target_index];
        Ok(V3Router07OpaqueTargetHitOnce {
            routing_group_id: pool.routing_group_id,
            pool_id: pool.pool_id,
            target_index,
            target_kind: target.kind.clone(),
            target_id: target.id.clone(),
            hit_count: 1,
        })
    }
}

fn build_pool(
    classified: V3Router05RequestClassified,
    pool: &V3RoutePoolManifest,
) -> V3Router06RoutePoolResolved {
    V3Router06RoutePoolResolved {
        server_id: classified.server_id,
        routing_group_id: classified.routing_group_id,
        pool_id: pool.id.clone(),
        selection: pool.selection.strategy.clone(),
        targets: pool.targets.clone(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::*;

    fn manifest(strategy: V3SelectionStrategy) -> V3Config05ManifestPublished {
        V3Config05ManifestPublished {
            version: 3,
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
                },
            )]),
            providers: BTreeMap::new(),
            forwarders: BTreeMap::new(),
            features: BTreeMap::new(),
            debug: V3DebugManifest {
                log_console: false,
                log_file: None,
                snapshots: false,
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
                    pools: BTreeMap::from([(
                        "default".into(),
                        V3RoutePoolManifest {
                            id: "default".into(),
                            selection: V3SelectionPolicy { strategy },
                            features: BTreeMap::new(),
                            targets: vec![
                                V3RoutePoolTargetManifest {
                                    kind: V3RouteTargetKind::Forwarder,
                                    id: Some("a".into()),
                                    provider: None,
                                    model: None,
                                    key: None,
                                    priority: Some(2),
                                    weight: Some(1),
                                },
                                V3RoutePoolTargetManifest {
                                    kind: V3RouteTargetKind::Forwarder,
                                    id: Some("b".into()),
                                    provider: None,
                                    model: None,
                                    key: None,
                                    priority: Some(1),
                                    weight: Some(3),
                                },
                            ],
                        },
                    )]),
                },
            )]),
        }
    }

    #[test]
    fn resolves_listener_default_and_hits_one_opaque_target() {
        let router = V3VirtualRouter::default();
        let manifest = manifest(V3SelectionStrategy::Priority);
        let classified = router
            .classify_request(&manifest, "s", "/v1/responses")
            .unwrap();
        let pool = router.resolve_default_pool(&manifest, classified).unwrap();
        let hit = router.hit_opaque_target_once(pool, 0).unwrap();
        assert_eq!(hit.target_id.as_deref(), Some("b"));
        assert_eq!(hit.hit_count, 1);
    }

    #[test]
    fn weighted_and_round_robin_are_deterministic() {
        let router = V3VirtualRouter::default();
        let weighted = manifest(V3SelectionStrategy::Weighted);
        let pool = router
            .resolve_default_pool(
                &weighted,
                router
                    .classify_request(&weighted, "s", "/v1/responses")
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            router
                .hit_opaque_target_once(pool, 1)
                .unwrap()
                .target_id
                .as_deref(),
            Some("b")
        );
        let rr = manifest(V3SelectionStrategy::RoundRobin);
        let pool = || {
            router
                .resolve_default_pool(
                    &rr,
                    router.classify_request(&rr, "s", "/v1/responses").unwrap(),
                )
                .unwrap()
        };
        assert_eq!(
            router
                .hit_opaque_target_once(pool(), 0)
                .unwrap()
                .target_id
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            router
                .hit_opaque_target_once(pool(), 0)
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
            router.resolve_default_pool(&missing, classified),
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
            router.resolve_default_pool(&empty, classified),
            Err(V3VirtualRouterError::DefaultPoolEmpty("g".into()))
        );
    }
}
