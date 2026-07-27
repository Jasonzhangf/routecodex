use routecodex_v3_config::{
    V3Config05ManifestPublished, V3DirectModelResolution, V3RoutePoolManifest,
    V3RoutePoolMatchManifest, V3RoutePoolTargetManifest, V3RouteTargetKind, V3SelectionStrategy,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};

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
                matched_pools.push((
                    route_contract_priority(pool_id, match_rule, &classified.facts),
                    match_rule.precedence,
                    pool_id.clone(),
                ));
            }
        }
        matched_pools.sort();
        let best_priority = matched_pools.first().map(|(priority, _, _)| *priority);
        let best_precedence = matched_pools.first().map(|(_, precedence, _)| *precedence);
        let best_pool_ids = matched_pools
            .iter()
            .take_while(|(priority, precedence, _)| {
                Some(*priority) == best_priority && Some(*precedence) == best_precedence
            })
            .map(|(_, _, pool_id)| pool_id.clone())
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

fn route_contract_priority(
    pool_id: &str,
    rule: &V3RoutePoolMatchManifest,
    facts: &V3RouterRequestFacts,
) -> i32 {
    if pool_route_signal_matches(pool_id, rule, &["longcontext"])
        && rule
            .min_input_tokens
            .is_some_and(|minimum| facts.input_tokens >= minimum)
    {
        return 0;
    }
    if pool_route_signal_matches(pool_id, rule, &["multimodal", "vision"]) {
        return 10;
    }
    if pool_route_signal_matches(pool_id, rule, &["web_search"]) {
        return 20;
    }
    if pool_route_signal_matches(pool_id, rule, &["longcontext"]) {
        return 30;
    }
    if rule.models.iter().any(|model| {
        facts
            .client_model
            .as_ref()
            .is_some_and(|client_model| client_model == model)
    }) {
        return 35;
    }
    if pool_route_signal_matches(pool_id, rule, &["thinking", "reasoning"]) {
        return 40;
    }
    if pool_route_signal_matches(pool_id, rule, &["coding"]) {
        return 50;
    }
    if pool_route_signal_matches(pool_id, rule, &["search"]) {
        return 60;
    }
    if pool_route_signal_matches(pool_id, rule, &["tools"]) {
        return 70;
    }
    100
}

fn pool_route_signal_matches(
    pool_id: &str,
    rule: &V3RoutePoolMatchManifest,
    signals: &[&str],
) -> bool {
    signals.iter().any(|signal| {
        pool_id == *signal
            || rule
                .required_capabilities
                .iter()
                .any(|capability| capability == signal)
    })
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
                provider_error_action_policy: Vec::new(),
                client_error_projection_policy: Vec::new(),
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

    fn manifest_with_direct_provider() -> V3Config05ManifestPublished {
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        manifest.providers.insert(
            "prov".into(),
            V3ProviderManifest {
                id: "prov".into(),
                enabled: true,
                provider_type: "responses".into(),
                base_url: "http://127.0.0.1:9/v1".into(),
                default_model: "model-x".into(),
                auth: V3ProviderAuthManifest {
                    auth_type: V3ProviderAuthType::ApiKey,
                    entries: vec![V3ProviderAuthEntryManifest {
                        alias: "key1".into(),
                        env: Some("PROV_KEY".into()),
                        token_file: None,
                    }],
                },
                models: BTreeMap::from([(
                    "model-x".into(),
                    V3ProviderModelManifest {
                        id: "model-x".into(),
                        wire_name: "model-x-wire".into(),
                        aliases: vec!["mx".into()],
                        capabilities: vec!["text".into()],
                        supports_streaming: true,
                        supports_thinking: false,
                        thinking: None,
                        max_tokens: None,
                        max_context_tokens: None,
                        features: BTreeMap::new(),
                    },
                )]),
                responses: None,
                concurrency: None,
                health: None,
                provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
                compatibility_profile: None,
                features: BTreeMap::new(),
            },
        );
        manifest
    }

    fn direct_facts(model: &str, capabilities: BTreeSet<String>) -> V3RouterRequestFacts {
        V3RouterRequestFacts {
            entry_protocol: "responses".into(),
            client_model: Some(model.into()),
            capabilities,
            input_tokens: 10,
        }
    }

    #[test]
    fn direct_provider_model_short_circuits_pool_matching() {
        let router = V3VirtualRouter::default();
        let manifest = manifest_with_direct_provider();
        for requested in ["prov.model-x", "prov.mx"] {
            let classified = router
                .classify_request_with_facts(
                    &manifest,
                    "s",
                    "/v1/responses",
                    direct_facts(requested, BTreeSet::new()),
                )
                .unwrap();
            let plan = router
                .resolve_route_pool_plan(&manifest, classified)
                .unwrap();
            let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
            assert_eq!(hit.pool_id, "direct");
            assert_eq!(hit.target_plan.len(), 1);
            assert_eq!(
                hit.target_plan[0].direct_provider_model,
                Some(("prov".to_string(), "model-x".to_string()))
            );
            assert_eq!(
                hit.request_client_model.as_deref(),
                Some("model-x"),
                "client model must be rewritten to the bare canonical id"
            );
        }
    }

    #[test]
    fn direct_unknown_provider_falls_back_to_classification() {
        let router = V3VirtualRouter::default();
        let manifest = manifest_with_direct_provider();
        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                direct_facts("nosuch.model-x", BTreeSet::new()),
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
        assert_eq!(
            hit.pool_id, "default",
            "unknown provider segment must fall back to normal pool routing"
        );
    }

    #[test]
    fn direct_unknown_model_and_media_mismatch_fail_without_reroute() {
        let router = V3VirtualRouter::default();
        let manifest = manifest_with_direct_provider();
        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                direct_facts("prov.absent-model", BTreeSet::new()),
            )
            .unwrap();
        assert_eq!(
            router.resolve_route_pool_plan(&manifest, classified),
            Err(V3VirtualRouterError::DirectModelUnknown {
                provider: "prov".into(),
                model: "absent-model".into(),
            })
        );

        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                direct_facts("prov.model-x", BTreeSet::from(["vision".into()])),
            )
            .unwrap();
        assert_eq!(
            router.resolve_route_pool_plan(&manifest, classified),
            Err(V3VirtualRouterError::DirectModelMediaUnsatisfied {
                provider: "prov".into(),
                model: "model-x".into(),
                capability: "vision".into(),
            })
        );
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

    fn add_match_pool(
        manifest: &mut V3Config05ManifestPublished,
        pool_id: &str,
        precedence: i32,
        required_capabilities: Vec<&str>,
        min_input_tokens: Option<u64>,
    ) {
        manifest.route_groups.get_mut("g").unwrap().pools.insert(
            pool_id.into(),
            V3RoutePoolManifest {
                id: pool_id.into(),
                selection: V3SelectionPolicy {
                    strategy: V3SelectionStrategy::Priority,
                },
                match_rule: Some(V3RoutePoolMatchManifest {
                    precedence,
                    entry_protocol: Some("responses".into()),
                    models: Vec::new(),
                    required_capabilities: required_capabilities
                        .into_iter()
                        .map(ToOwned::to_owned)
                        .collect(),
                    min_input_tokens,
                    max_input_tokens: None,
                }),
                features: BTreeMap::new(),
                targets: vec![target(pool_id, 1, 1)],
            },
        );
    }

    fn add_model_match_pool(
        manifest: &mut V3Config05ManifestPublished,
        pool_id: &str,
        precedence: i32,
        model: &str,
    ) {
        manifest.route_groups.get_mut("g").unwrap().pools.insert(
            pool_id.into(),
            V3RoutePoolManifest {
                id: pool_id.into(),
                selection: V3SelectionPolicy {
                    strategy: V3SelectionStrategy::Priority,
                },
                match_rule: Some(V3RoutePoolMatchManifest {
                    precedence,
                    entry_protocol: Some("responses".into()),
                    models: vec![model.into()],
                    required_capabilities: Vec::new(),
                    min_input_tokens: None,
                    max_input_tokens: None,
                }),
                features: BTreeMap::new(),
                targets: vec![target(pool_id, 1, 1)],
            },
        );
    }

    #[test]
    fn route_contract_prefers_web_search_over_generic_tools_even_when_precedence_is_lower() {
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
            .precedence = 20;
        add_match_pool(&mut manifest, "web_search", 22, vec!["web_search"], None);

        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: Some("client-model".into()),
                    capabilities: BTreeSet::from(["tools".into(), "web_search".into()]),
                    input_tokens: 10,
                },
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

        assert_eq!(hit.pool_id, "web_search");
    }

    #[test]
    fn route_contract_prefers_multimodal_over_all_non_context_route_signals() {
        let router = V3VirtualRouter::default();
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        add_match_pool(&mut manifest, "thinking", 1, vec!["thinking"], None);
        add_match_pool(&mut manifest, "coding", 2, vec!["coding"], None);
        add_match_pool(&mut manifest, "search", 3, vec!["search"], None);
        add_match_pool(&mut manifest, "web_search", 4, vec!["web_search"], None);
        add_match_pool(&mut manifest, "multimodal", 99, vec!["multimodal"], None);

        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: Some("client-model".into()),
                    capabilities: BTreeSet::from([
                        "tools".into(),
                        "coding".into(),
                        "search".into(),
                        "web_search".into(),
                        "thinking".into(),
                        "multimodal".into(),
                    ]),
                    input_tokens: 10,
                },
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

        assert_eq!(hit.pool_id, "multimodal");
    }

    #[test]
    fn route_contract_treats_min_token_longcontext_as_context_safety_first() {
        let router = V3VirtualRouter::default();
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        add_match_pool(&mut manifest, "multimodal", 1, vec!["multimodal"], None);
        add_match_pool(&mut manifest, "web_search", 2, vec!["web_search"], None);
        add_match_pool(&mut manifest, "longcontext", 100, Vec::new(), Some(1_000));

        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: Some("client-model".into()),
                    capabilities: BTreeSet::from(["multimodal".into(), "web_search".into()]),
                    input_tokens: 1_000,
                },
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

        assert_eq!(hit.pool_id, "longcontext");
    }

    #[test]
    fn route_contract_prefers_explicit_model_pool_over_generic_thinking() {
        let router = V3VirtualRouter::default();
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        add_match_pool(&mut manifest, "thinking", 1, vec!["thinking"], None);
        add_model_match_pool(&mut manifest, "client_test", 99, "client-test");

        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: Some("client-test".into()),
                    capabilities: BTreeSet::from(["thinking".into()]),
                    input_tokens: 10,
                },
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

        assert_eq!(hit.pool_id, "client_test");
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
    fn weighted_selection_follows_smooth_weighted_round_robin_sequence() {
        let router = V3VirtualRouter::default();
        let mut weighted = manifest(V3SelectionStrategy::Weighted);
        let pool = weighted
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .get_mut("default")
            .unwrap();
        pool.targets = vec![target("a", 1, 5), target("b", 1, 1), target("c", 1, 1)];
        let mut first_choices = Vec::new();
        for _request in 0..7 {
            let plan = router
                .resolve_route_pool_plan(
                    &weighted,
                    router
                        .classify_request(&weighted, "s", "/v1/responses")
                        .unwrap(),
                )
                .unwrap();
            let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
            first_choices.push(hit.target_id.unwrap());
        }
        // Canonical nginx SWRR emission for weights 5/1/1.
        assert_eq!(first_choices, vec!["a", "a", "b", "a", "c", "a", "a"]);
    }

    #[test]
    fn peek_does_not_advance_selection_state() {
        let router = V3VirtualRouter::default();
        let rr = manifest(V3SelectionStrategy::RoundRobin);
        let plan = |router: &V3VirtualRouter| {
            router
                .resolve_route_pool_plan(
                    &rr,
                    router.classify_request(&rr, "s", "/v1/responses").unwrap(),
                )
                .unwrap()
        };
        let peek_one = router
            .hit_opaque_target_plan_once_peek(plan(&router), 0)
            .unwrap();
        let peek_two = router
            .hit_opaque_target_plan_once_peek(plan(&router), 0)
            .unwrap();
        assert_eq!(peek_one.target_id, peek_two.target_id);
        let live = router
            .hit_opaque_target_plan_once(plan(&router), 0)
            .unwrap();
        assert_eq!(live.target_id, peek_one.target_id);
        let peek_after = router
            .hit_opaque_target_plan_once_peek(plan(&router), 0)
            .unwrap();
        assert_ne!(peek_after.target_id, live.target_id);

        let weighted = manifest(V3SelectionStrategy::Weighted);
        let wplan = |router: &V3VirtualRouter| {
            router
                .resolve_route_pool_plan(
                    &weighted,
                    router
                        .classify_request(&weighted, "s", "/v1/responses")
                        .unwrap(),
                )
                .unwrap()
        };
        let wpeek_one = router
            .hit_opaque_target_plan_once_peek(wplan(&router), 0)
            .unwrap();
        let wpeek_two = router
            .hit_opaque_target_plan_once_peek(wplan(&router), 0)
            .unwrap();
        assert_eq!(wpeek_one.target_id, wpeek_two.target_id);
    }

    #[test]
    fn process_shared_router_persists_selection_state_across_instances() {
        let rr = manifest(V3SelectionStrategy::RoundRobin);
        // Unique group id so this test never shares state with other tests
        // using the process-wide router.
        let mut rr_scoped = rr.clone();
        let group = rr_scoped.route_groups.remove("g").unwrap();
        rr_scoped.route_groups.insert("g-shared-test".into(), group);
        rr_scoped.servers.get_mut("s").unwrap().routing_group = "g-shared-test".into();
        let hit = |router: &V3VirtualRouter| {
            let plan = router
                .resolve_route_pool_plan(
                    &rr_scoped,
                    router
                        .classify_request(&rr_scoped, "s", "/v1/responses")
                        .unwrap(),
                )
                .unwrap();
            router
                .hit_opaque_target_plan_once(plan, 0)
                .unwrap()
                .target_id
                .unwrap()
        };
        let first = hit(&V3VirtualRouter::process_shared());
        let second = hit(&V3VirtualRouter::process_shared());
        assert_ne!(
            first, second,
            "process-shared router instances must rotate the same cursor"
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
