use routecodex_v3_config::{
    V3Config05ManifestPublished, V3DirectModelResolution, V3RoutePoolManifest,
    V3RoutePoolMatchManifest, V3RoutePoolTargetManifest, V3RouteTargetKind, V3SelectionStrategy,
};
pub use routecodex_v3_route_classifier::RouteClassification;
use routecodex_v3_route_classifier::{DEFAULT_ROUTE, ROUTE_PRIORITY};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RouterRequestFacts {
    pub entry_protocol: String,
    pub client_model: Option<String>,
    pub capabilities: BTreeSet<String>,
    pub input_tokens: u64,
    pub route_classification: RouteClassification,
}

impl V3RouterRequestFacts {
    pub fn from_endpoint(endpoint: &str) -> Self {
        Self {
            entry_protocol: protocol_from_endpoint(endpoint),
            client_model: None,
            capabilities: BTreeSet::new(),
            input_tokens: 0,
            route_classification: RouteClassification::default(),
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
    direct_provider_model: Option<(String, String)>,
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
    pub request_client_model: Option<String>,
    pub request_capabilities: BTreeSet<String>,
    pub request_input_tokens: u64,
    pub hit_count: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Router07OpaqueTargetPlanEntry {
    pub tier_index: usize,
    pub pool_id: String,
    pub target_index: usize,
    pub target_kind: V3RouteTargetKind,
    pub target_id: Option<String>,
    /// Set only for `provider.model` direct routes: the resolved provider and
    /// canonical model, carried on the plan because the synthetic `direct`
    /// pool has no manifest declaration for Target to look up.
    pub direct_provider_model: Option<(String, String)>,
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
    #[error("unknown model {model} for provider {provider}")]
    DirectModelUnknown { provider: String, model: String },
    #[error("direct route {provider}.{model} cannot serve this request: model lacks {capability}")]
    DirectModelMediaUnsatisfied {
        provider: String,
        model: String,
        capability: String,
    },
}

#[derive(Debug, Default)]
struct V3RouterSelectionState {
    cursors: BTreeMap<String, usize>,
    swrr_current: BTreeMap<String, Vec<i64>>,
}

#[derive(Debug, Clone, Default)]
pub struct V3VirtualRouter {
    selection_state: Arc<Mutex<V3RouterSelectionState>>,
}

impl V3VirtualRouter {
    /// Router backed by process-wide selection state so round-robin cursors and
    /// SWRR scores survive across requests. State keys are
    /// `server:group:pool`, so listeners never share a cursor.
    pub fn process_shared() -> Self {
        static SHARED: OnceLock<Arc<Mutex<V3RouterSelectionState>>> = OnceLock::new();
        Self {
            selection_state: SHARED.get_or_init(Default::default).clone(),
        }
    }

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
        if let Some(direct) = resolve_v3_direct_model_plan(manifest, &classified) {
            return direct;
        }
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

        for (pool_id, pool) in &group.pools {
            if pool_id == DEFAULT_ROUTE {
                continue;
            }
            if pool.match_rule.is_none() {
                return Err(V3VirtualRouterError::PoolMatchMissing {
                    group_id: classified.routing_group_id.clone(),
                    pool_id: pool_id.clone(),
                });
            }
        }

        let mut tiers = Vec::new();
        let mut selected_pool_ids = BTreeSet::new();
        if let Some(client_model) = classified.facts.client_model.as_deref() {
            if let Some(pool) = select_best_matching_pool(
                &classified.routing_group_id,
                &group.pools,
                &classified.facts,
                |pool_id, rule| {
                    !pool_has_route_signal(pool_id, rule)
                        && rule.models.iter().any(|model| model == client_model)
                },
            )? {
                append_route_pool_tier(
                    &classified.routing_group_id,
                    pool,
                    &mut selected_pool_ids,
                    &mut tiers,
                )?;
            }
        }
        for candidate in &classified.facts.route_classification.candidates {
            if candidate == DEFAULT_ROUTE {
                continue;
            }
            if let Some(pool) = select_best_matching_pool(
                &classified.routing_group_id,
                &group.pools,
                &classified.facts,
                |pool_id, rule| pool_route_signal_matches(pool_id, rule, candidate),
            )? {
                append_route_pool_tier(
                    &classified.routing_group_id,
                    pool,
                    &mut selected_pool_ids,
                    &mut tiers,
                )?;
            }
        }
        if tiers.is_empty() {
            if let Some(pool) = select_best_matching_pool(
                &classified.routing_group_id,
                &group.pools,
                &classified.facts,
                |pool_id, rule| !pool_has_route_signal(pool_id, rule),
            )? {
                append_route_pool_tier(
                    &classified.routing_group_id,
                    pool,
                    &mut selected_pool_ids,
                    &mut tiers,
                )?;
            }
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
        self.hit_opaque_target_plan(plan, deterministic_sample, true)
    }

    /// Dry-run variant: computes the same ordering as
    /// `hit_opaque_target_plan_once` from the current selection state without
    /// advancing round-robin cursors or SWRR scores.
    pub fn hit_opaque_target_plan_once_peek(
        &self,
        plan: V3Router06RoutePoolResolved,
        deterministic_sample: u64,
    ) -> Result<V3Router07OpaqueTargetHitOnce, V3VirtualRouterError> {
        self.hit_opaque_target_plan(plan, deterministic_sample, false)
    }

    fn hit_opaque_target_plan(
        &self,
        plan: V3Router06RoutePoolResolved,
        deterministic_sample: u64,
        advance_state: bool,
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
                &self.selection_state,
                advance_state,
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
                    direct_provider_model: tier.direct_provider_model.clone(),
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
            request_client_model: plan.facts.client_model,
            request_capabilities: plan.facts.capabilities,
            request_input_tokens: plan.facts.input_tokens,
            hit_count: 1,
        })
    }
}

fn build_plan_tier(pool: &V3RoutePoolManifest) -> V3Router06SelectionPlanTier {
    V3Router06SelectionPlanTier {
        pool_id: pool.id.clone(),
        selection: pool.selection.strategy.clone(),
        targets: pool.targets.clone(),
        direct_provider_model: None,
    }
}

fn select_best_matching_pool<'a, F>(
    group_id: &str,
    pools: &'a BTreeMap<String, V3RoutePoolManifest>,
    facts: &V3RouterRequestFacts,
    mut candidate_matches: F,
) -> Result<Option<&'a V3RoutePoolManifest>, V3VirtualRouterError>
where
    F: FnMut(&str, &V3RoutePoolMatchManifest) -> bool,
{
    let mut matches = pools
        .iter()
        .filter_map(|(pool_id, pool)| {
            if pool_id == DEFAULT_ROUTE {
                return None;
            }
            let rule = pool.match_rule.as_ref()?;
            (pool_matches(rule, facts) && candidate_matches(pool_id, rule)).then_some((
                rule.precedence,
                pool_id.as_str(),
                pool,
            ))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(right.1)));
    let Some((best_precedence, _, best_pool)) = matches.first().copied() else {
        return Ok(None);
    };
    let equally_ranked = matches
        .iter()
        .take_while(|(precedence, _, _)| *precedence == best_precedence)
        .map(|(_, pool_id, _)| (*pool_id).to_string())
        .collect::<Vec<_>>();
    if equally_ranked.len() > 1 {
        return Err(V3VirtualRouterError::AmbiguousPoolMatches {
            group_id: group_id.to_string(),
            pool_ids: equally_ranked,
        });
    }
    Ok(Some(best_pool))
}

fn append_route_pool_tier(
    group_id: &str,
    pool: &V3RoutePoolManifest,
    selected_pool_ids: &mut BTreeSet<String>,
    tiers: &mut Vec<V3Router06SelectionPlanTier>,
) -> Result<(), V3VirtualRouterError> {
    if !selected_pool_ids.insert(pool.id.clone()) {
        return Ok(());
    }
    if pool.targets.is_empty() {
        return Err(V3VirtualRouterError::PoolEmpty {
            group_id: group_id.to_string(),
            pool_id: pool.id.clone(),
        });
    }
    tiers.push(build_plan_tier(pool));
    Ok(())
}

/// `provider.model` direct routing, matching the V2 engine semantics: when the
/// client model splits on its first `.` into an existing provider id, the
/// request pins that provider and skips pool matching entirely. An unknown
/// provider segment falls back to normal classification (returns None); an
/// unknown model or an unsatisfiable media requirement fails explicitly
/// without rerouting. Provider/model interpretation stays in the config layer
/// (`resolve_direct_provider_model`); the router only consumes the resolution.
fn resolve_v3_direct_model_plan(
    manifest: &V3Config05ManifestPublished,
    classified: &V3Router05RequestClassified,
) -> Option<Result<V3Router06RoutePoolResolved, V3VirtualRouterError>> {
    let requested = classified.facts.client_model.as_deref()?;
    let (direct_provider_id, direct_model_id, model_capabilities) =
        match manifest.resolve_direct_provider_model(requested) {
            V3DirectModelResolution::NotDirect => return None,
            V3DirectModelResolution::UnknownModel {
                provider_id,
                model_id,
            } => {
                return Some(Err(V3VirtualRouterError::DirectModelUnknown {
                    provider: provider_id,
                    model: model_id,
                }))
            }
            V3DirectModelResolution::Resolved {
                provider_id,
                model_id,
                model_capabilities,
            } => (provider_id, model_id, model_capabilities),
        };
    for media_capability in ["vision", "multimodal"] {
        if classified.facts.capabilities.contains(media_capability)
            && !model_capabilities
                .iter()
                .any(|capability| capability == "vision" || capability == "multimodal")
        {
            return Some(Err(V3VirtualRouterError::DirectModelMediaUnsatisfied {
                provider: direct_provider_id,
                model: direct_model_id,
                capability: media_capability.to_string(),
            }));
        }
    }
    let mut facts = classified.facts.clone();
    // Rewrite to the bare canonical model so downstream requested-model
    // filtering matches the provider's visible model ids.
    facts.client_model = Some(direct_model_id.clone());
    Some(Ok(V3Router06RoutePoolResolved {
        server_id: classified.server_id.clone(),
        routing_group_id: classified.routing_group_id.clone(),
        facts,
        tiers: vec![V3Router06SelectionPlanTier {
            pool_id: "direct".to_string(),
            selection: V3SelectionStrategy::RoundRobin,
            targets: vec![V3RoutePoolTargetManifest {
                kind: V3RouteTargetKind::ProviderModel,
                id: None,
                provider: Some(direct_provider_id.clone()),
                model: Some(direct_model_id.clone()),
                key: None,
                priority: Some(1),
                weight: Some(1),
            }],
            direct_provider_model: Some((direct_provider_id, direct_model_id)),
        }],
    }))
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

fn pool_route_signal_matches(pool_id: &str, rule: &V3RoutePoolMatchManifest, signal: &str) -> bool {
    pool_id == signal
        || rule
            .required_capabilities
            .iter()
            .any(|capability| capability == signal)
}

fn pool_has_route_signal(pool_id: &str, rule: &V3RoutePoolMatchManifest) -> bool {
    is_hard_capability_pool_signal(pool_id)
        || rule
            .required_capabilities
            .iter()
            .any(|capability| is_hard_capability_pool_signal(capability))
        || ROUTE_PRIORITY.iter().any(|signal| {
            *signal != DEFAULT_ROUTE && pool_route_signal_matches(pool_id, rule, signal)
        })
}

fn is_hard_capability_pool_signal(signal: &str) -> bool {
    matches!(signal, "web_search" | "search" | "vision" | "multimodal")
}

#[allow(clippy::too_many_arguments)]
fn ordered_target_indices(
    strategy: &V3SelectionStrategy,
    targets: &[V3RoutePoolTargetManifest],
    _sample: u64,
    server_id: &str,
    routing_group_id: &str,
    pool_id: &str,
    selection_state: &Arc<Mutex<V3RouterSelectionState>>,
    advance_state: bool,
) -> Vec<usize> {
    match strategy {
        V3SelectionStrategy::Priority => {
            let mut order = (0..targets.len()).collect::<Vec<_>>();
            order.sort_by_key(|index| (targets[*index].priority.unwrap_or(0), *index));
            order
        }
        V3SelectionStrategy::Weighted => {
            let key = format!("{server_id}:{routing_group_id}:{pool_id}");
            let mut state = selection_state.lock().expect("router selection state lock");
            let current = state.swrr_current.entry(key).or_default();
            if current.len() != targets.len() {
                *current = vec![0; targets.len()];
            }
            swrr_order(targets, current, advance_state)
        }
        V3SelectionStrategy::RoundRobin => {
            let key = format!("{server_id}:{routing_group_id}:{pool_id}");
            let mut state = selection_state.lock().expect("router selection state lock");
            let cursor = state.cursors.entry(key).or_default();
            let start = *cursor % targets.len();
            if advance_state {
                *cursor = cursor.wrapping_add(1);
            }
            (0..targets.len())
                .map(|offset| (start + offset) % targets.len())
                .collect()
        }
    }
}

/// Smooth weighted round-robin (nginx SWRR), ported from the V2 engine: each
/// step adds every target's weight to its running score, emits the highest
/// score, then subtracts the total weight from the emitted target. Per request
/// only the first emission advances the persistent scores (`current`); the
/// remaining ranks are secondary ordering computed on a scratch copy.
fn swrr_order(
    targets: &[V3RoutePoolTargetManifest],
    current: &mut Vec<i64>,
    advance_state: bool,
) -> Vec<usize> {
    let weights = targets
        .iter()
        .map(|target| i64::from(target.weight.unwrap_or(1).max(1)))
        .collect::<Vec<_>>();
    let total_weight: i64 = weights.iter().sum();
    let mut scratch = current.clone();
    let mut order = Vec::with_capacity(targets.len());
    let mut emitted = vec![false; targets.len()];
    for rank in 0..targets.len() {
        for (index, weight) in weights.iter().enumerate() {
            scratch[index] += weight;
        }
        let selected = (0..targets.len())
            .filter(|index| !emitted[*index])
            .max_by_key(|index| (scratch[*index], std::cmp::Reverse(*index)))
            .expect("non-empty unemitted target set");
        scratch[selected] -= total_weight;
        emitted[selected] = true;
        order.push(selected);
        if rank == 0 && advance_state {
            *current = scratch.clone();
        }
    }
    order
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
mod tests;
