use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ForwarderTargetManifest, V3RoutePoolTargetManifest,
    V3RouteTargetKind, V3SelectionStrategy,
};
use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
use routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Target08KindClassified {
    pub route: V3Router07OpaqueTargetHitOnce,
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_provider_responses::V3ProviderAvailabilityProjection;
    use routecodex_v3_virtual_router::V3VirtualRouter;

    struct Availability {
        blocked: BTreeSet<String>,
    }

    impl V3ProviderAvailabilityReader for Availability {
        fn availability(
            &self,
            provider_id: &str,
            auth_alias: Option<&str>,
            model_id: Option<&str>,
            _now_ms: u64,
        ) -> V3ProviderAvailabilityProjection {
            let label = format!(
                "{provider_id}:{}:{}",
                auth_alias.unwrap_or(""),
                model_id.unwrap_or("")
            );
            V3ProviderAvailabilityProjection {
                provider_id: provider_id.into(),
                auth_alias: auth_alias.map(Into::into),
                model_id: model_id.map(Into::into),
                available: !self.blocked.contains(&label),
                blocked_scopes: self
                    .blocked
                    .contains(&label)
                    .then_some(label)
                    .into_iter()
                    .collect(),
            }
        }
    }

    fn manifest() -> V3Config05ManifestPublished {
        let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.a]
type = "responses"
base_url = "http://a.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "ka", env = "KEY_A" }] }
[providers.a.models.m]
[providers.b]
type = "responses"
base_url = "http://b.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "kb", env = "KEY_B" }] }
[providers.b.models.m]
[forwarders.inner]
model = "m"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "a", model = "m", key = "ka", priority = 1 },
  { kind = "provider_model", provider = "b", model = "m", key = "kb", priority = 2 }
]
[forwarders.outer]
model = "m"
selection = { strategy = "round_robin" }
targets = [{ kind = "forwarder", id = "inner" }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "outer", priority = 1 }]
"#;
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap()
    }

    fn expanded() -> V3Target09CandidateSetExpanded {
        let manifest = manifest();
        expanded_with(&manifest, &V3TargetInterpreter::default(), 0)
    }

    fn expanded_with(
        manifest: &V3Config05ManifestPublished,
        target: &V3TargetInterpreter,
        sample: u64,
    ) -> V3Target09CandidateSetExpanded {
        let router = V3VirtualRouter::default();
        let classified = router
            .classify_request(manifest, "s", "/v1/responses")
            .unwrap();
        let pool = router.resolve_default_pool(manifest, classified).unwrap();
        let hit = router.hit_opaque_target_once(pool, 0).unwrap();
        target
            .expand_candidates(manifest, target.classify_kind(hit), sample)
            .unwrap()
    }

    #[test]
    fn nested_forwarder_expands_and_reselects_inside_same_route_hit() {
        let expanded = expanded();
        assert_eq!(expanded.route.hit_count, 1);
        assert_eq!(expanded.candidates.len(), 2);
        let selected = V3TargetInterpreter::default()
            .select_available(
                expanded,
                &Availability {
                    blocked: BTreeSet::from(["a:ka:m".into()]),
                },
                0,
            )
            .unwrap();
        assert_eq!(selected.route.hit_count, 1);
        assert_eq!(selected.candidate.provider_id, "b");
        assert_eq!(selected.attempts, 2);
    }

    #[test]
    fn all_internal_candidates_unavailable_is_explicit_exhaustion() {
        let exhausted = V3TargetInterpreter::default()
            .select_available(
                expanded(),
                &Availability {
                    blocked: BTreeSet::from(["a:ka:m".into(), "b:kb:m".into()]),
                },
                0,
            )
            .unwrap_err();
        assert_eq!(exhausted.route.hit_count, 1);
        assert_eq!(exhausted.attempted_candidates.len(), 2);
    }

    #[test]
    fn forwarder_weighted_and_round_robin_order_are_deterministic() {
        let mut weighted = manifest();
        let inner = weighted.forwarders.get_mut("inner").unwrap();
        inner.selection.strategy = V3SelectionStrategy::Weighted;
        inner.targets[0].weight = Some(1);
        inner.targets[1].weight = Some(3);
        let interpreter = V3TargetInterpreter::default();
        assert_eq!(
            expanded_with(&weighted, &interpreter, 1).candidates[0].provider_id,
            "b"
        );

        let mut round_robin = manifest();
        round_robin
            .forwarders
            .get_mut("inner")
            .unwrap()
            .selection
            .strategy = V3SelectionStrategy::RoundRobin;
        let interpreter = V3TargetInterpreter::default();
        assert_eq!(
            expanded_with(&round_robin, &interpreter, 0).candidates[0].provider_id,
            "a"
        );
        assert_eq!(
            expanded_with(&round_robin, &interpreter, 0).candidates[0].provider_id,
            "b"
        );
    }

    #[test]
    fn malformed_internal_member_does_not_escape_while_a_sibling_remains() {
        let mut malformed = manifest();
        malformed.forwarders.get_mut("inner").unwrap().targets[0].provider = Some("missing".into());
        let expanded = expanded_with(&malformed, &V3TargetInterpreter::default(), 0);
        assert_eq!(expanded.route.hit_count, 1);
        assert_eq!(expanded.candidates.len(), 1);
        assert_eq!(expanded.candidates[0].provider_id, "b");
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3TargetCandidate {
    pub provider_id: String,
    pub auth_alias: String,
    pub model_id: String,
    pub wire_model: String,
    pub base_url: String,
    pub env_name: Option<String>,
    pub token_file: Option<String>,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Target09CandidateSetExpanded {
    pub route: V3Router07OpaqueTargetHitOnce,
    pub candidates: Vec<V3TargetCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Target10ConcreteProviderSelected {
    pub route: V3Router07OpaqueTargetHitOnce,
    pub candidate: V3TargetCandidate,
    pub unavailable_candidates: Vec<String>,
    pub attempts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3TargetExhaustion {
    pub route: V3Router07OpaqueTargetHitOnce,
    pub attempted_candidates: Vec<String>,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum V3TargetError {
    #[error("route group or default pool is absent for selected target")]
    SelectedPoolMissing,
    #[error("selected opaque target index is invalid")]
    OpaqueTargetMissing,
    #[error("forwarder {0} is absent or disabled")]
    ForwarderMissing(String),
    #[error("forwarder cycle detected at {0}")]
    ForwarderCycle(String),
    #[error("provider target declaration is incomplete")]
    ProviderTargetIncomplete,
    #[error("provider {0} is absent or disabled")]
    ProviderMissing(String),
    #[error("provider {provider_id} model {model_id} is absent")]
    ModelMissing {
        provider_id: String,
        model_id: String,
    },
    #[error("provider {provider_id} auth key {auth_alias} is absent")]
    AuthMissing {
        provider_id: String,
        auth_alias: String,
    },
    #[error("selected target has no concrete candidates")]
    CandidateSetEmpty,
}

#[derive(Debug, Clone, Default)]
pub struct V3TargetInterpreter {
    cursors: Arc<Mutex<BTreeMap<String, usize>>>,
}

impl V3TargetInterpreter {
    pub fn classify_kind(&self, route: V3Router07OpaqueTargetHitOnce) -> V3Target08KindClassified {
        V3Target08KindClassified { route }
    }

    pub fn expand_candidates(
        &self,
        manifest: &V3Config05ManifestPublished,
        classified: V3Target08KindClassified,
        deterministic_sample: u64,
    ) -> Result<V3Target09CandidateSetExpanded, V3TargetError> {
        let target = manifest
            .route_groups
            .get(&classified.route.routing_group_id)
            .and_then(|group| group.pools.get(&classified.route.pool_id))
            .and_then(|pool| pool.targets.get(classified.route.target_index))
            .ok_or(V3TargetError::OpaqueTargetMissing)?;
        let mut visited = BTreeSet::new();
        let candidates = self.expand_route_target(
            manifest,
            target,
            deterministic_sample,
            &mut visited,
            vec![format!("pool:{}", classified.route.pool_id)],
        )?;
        if candidates.is_empty() {
            return Err(V3TargetError::CandidateSetEmpty);
        }
        Ok(V3Target09CandidateSetExpanded {
            route: classified.route,
            candidates,
        })
    }

    pub fn select_available<R: V3ProviderAvailabilityReader>(
        &self,
        expanded: V3Target09CandidateSetExpanded,
        availability: &R,
        now_ms: u64,
    ) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
        let mut unavailable = Vec::new();
        for (index, candidate) in expanded.candidates.iter().enumerate() {
            let projection = availability.availability(
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                now_ms,
            );
            if projection.available {
                return Ok(V3Target10ConcreteProviderSelected {
                    route: expanded.route,
                    candidate: candidate.clone(),
                    unavailable_candidates: unavailable,
                    attempts: index + 1,
                });
            }
            unavailable.push(format!(
                "{}:{}:{}",
                candidate.provider_id, candidate.auth_alias, candidate.model_id
            ));
        }
        Err(V3TargetExhaustion {
            route: expanded.route,
            attempted_candidates: unavailable,
        })
    }

    fn expand_route_target(
        &self,
        manifest: &V3Config05ManifestPublished,
        target: &V3RoutePoolTargetManifest,
        sample: u64,
        visited: &mut BTreeSet<String>,
        path: Vec<String>,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        match target.kind {
            V3RouteTargetKind::ProviderModel => self.expand_provider(
                manifest,
                target.provider.as_deref(),
                target.model.as_deref(),
                target.key.as_deref(),
                path,
            ),
            V3RouteTargetKind::Forwarder => self.expand_forwarder(
                manifest,
                target
                    .id
                    .as_deref()
                    .ok_or(V3TargetError::ProviderTargetIncomplete)?,
                sample,
                visited,
                path,
            ),
        }
    }

    fn expand_forwarder(
        &self,
        manifest: &V3Config05ManifestPublished,
        forwarder_id: &str,
        sample: u64,
        visited: &mut BTreeSet<String>,
        mut path: Vec<String>,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        if !visited.insert(forwarder_id.to_string()) {
            return Err(V3TargetError::ForwarderCycle(forwarder_id.to_string()));
        }
        path.push(format!("forwarder:{forwarder_id}"));
        let forwarder = manifest
            .forwarders
            .get(forwarder_id)
            .filter(|forwarder| forwarder.enabled)
            .ok_or_else(|| V3TargetError::ForwarderMissing(forwarder_id.to_string()))?;
        let order = self.policy_order(
            &forwarder.selection.strategy,
            &forwarder.targets,
            sample,
            forwarder_id,
        );
        let mut candidates = Vec::new();
        let mut last_error = None;
        for index in order {
            let target = &forwarder.targets[index];
            let nested = match target.kind {
                V3RouteTargetKind::ProviderModel => self.expand_provider(
                    manifest,
                    target.provider.as_deref(),
                    target.model.as_deref().or(Some(forwarder.model.as_str())),
                    target.key.as_deref(),
                    path.clone(),
                ),
                V3RouteTargetKind::Forwarder => self.expand_forwarder(
                    manifest,
                    target
                        .id
                        .as_deref()
                        .ok_or(V3TargetError::ProviderTargetIncomplete)?,
                    sample.wrapping_add(index as u64),
                    visited,
                    path.clone(),
                ),
            };
            match nested {
                Ok(mut nested) => candidates.append(&mut nested),
                Err(error) => last_error = Some(error),
            }
        }
        visited.remove(forwarder_id);
        if candidates.is_empty() {
            Err(last_error.unwrap_or(V3TargetError::CandidateSetEmpty))
        } else {
            Ok(candidates)
        }
    }

    fn expand_provider(
        &self,
        manifest: &V3Config05ManifestPublished,
        provider_id: Option<&str>,
        model_id: Option<&str>,
        key: Option<&str>,
        mut path: Vec<String>,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        let provider_id = provider_id.ok_or(V3TargetError::ProviderTargetIncomplete)?;
        let provider = manifest
            .providers
            .get(provider_id)
            .ok_or_else(|| V3TargetError::ProviderMissing(provider_id.to_string()))?;
        let model_id = model_id.unwrap_or(&provider.default_model);
        let model = provider
            .models
            .get(model_id)
            .ok_or_else(|| V3TargetError::ModelMissing {
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
            })?;
        path.push(format!("provider:{provider_id}"));
        let entries = if let Some(key) = key {
            vec![provider
                .auth
                .entries
                .iter()
                .find(|entry| entry.alias == key)
                .ok_or_else(|| V3TargetError::AuthMissing {
                    provider_id: provider_id.to_string(),
                    auth_alias: key.to_string(),
                })?]
        } else {
            provider.auth.entries.iter().collect()
        };
        Ok(entries
            .into_iter()
            .map(|entry| V3TargetCandidate {
                provider_id: provider_id.to_string(),
                auth_alias: entry.alias.clone(),
                model_id: model.id.clone(),
                wire_model: model.wire_name.clone(),
                base_url: provider.base_url.clone(),
                env_name: entry.env.clone(),
                token_file: entry.token_file.clone(),
                path: path.clone(),
            })
            .collect())
    }

    fn policy_order(
        &self,
        strategy: &V3SelectionStrategy,
        targets: &[V3ForwarderTargetManifest],
        sample: u64,
        forwarder_id: &str,
    ) -> Vec<usize> {
        let mut order = (0..targets.len()).collect::<Vec<_>>();
        match strategy {
            V3SelectionStrategy::Priority => {
                order.sort_by_key(|index| (targets[*index].priority.unwrap_or(0), *index))
            }
            V3SelectionStrategy::Weighted => {
                let total = targets
                    .iter()
                    .map(|target| u64::from(target.weight.unwrap_or(1)))
                    .sum::<u64>();
                let mut point = sample % total;
                let mut chosen = 0;
                for (index, target) in targets.iter().enumerate() {
                    let weight = u64::from(target.weight.unwrap_or(1));
                    if point < weight {
                        chosen = index;
                        break;
                    }
                    point -= weight;
                }
                order.rotate_left(chosen);
            }
            V3SelectionStrategy::RoundRobin => {
                let mut cursors = self.cursors.lock().expect("target cursor lock");
                let cursor = cursors.entry(forwarder_id.to_string()).or_default();
                let start = *cursor % targets.len();
                *cursor = cursor.wrapping_add(1);
                order.rotate_left(start);
            }
        }
        order
    }
}
