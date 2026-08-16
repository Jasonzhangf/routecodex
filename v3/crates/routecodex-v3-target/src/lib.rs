use routecodex_v3_config::{
    internal::is_v3_builtin_catalog_model, V3Config05ManifestPublished, V3ForwarderTargetManifest,
    V3ProviderModelManifest, V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind,
    V3RouteGroupManifest, V3RoutePoolManifest, V3RoutePoolTargetManifest, V3RouteTargetKind,
    V3SelectionStrategy, V3WebSearchExecutionMode,
};
use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
use routecodex_v3_virtual_router::{priority_tier_indices, V3Router07OpaqueTargetHitOnce};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Target08KindClassified {
    pub route: V3Router07OpaqueTargetHitOnce,
}

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3TargetCandidate {
    pub provider_id: String,
    pub provider_type: String,
    pub auth_alias: String,
    pub model_id: String,
    pub wire_model: String,
    pub visible_model_ids: Vec<String>,
    pub model_capabilities: Vec<String>,
    pub web_search_execution_mode: V3WebSearchExecutionMode,
    pub max_context_tokens: Option<u64>,
    pub context_token_estimate_scale_bps: u64,
    pub base_url: String,
    pub responses_process: Option<String>,
    pub responses_transport: V3ResponsesTransportKind,
    pub websocket_v2_url: Option<String>,
    pub provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig,
    pub request_timeout_ms: u64,
    pub initial_concurrency_budget: u32,
    pub compatibility_profile: Option<String>,
    pub env_name: Option<String>,
    pub token_file: Option<String>,
    pub secret_file: Option<String>,
    pub secret_key: Option<String>,
    pub api_key: Option<String>,
    pub required_capabilities: Vec<String>,
    pub pool_ids: Vec<String>,
    pub default_pool_member: bool,
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
    pub default_floor_protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("selected target exhausted after {attempted_candidates:?}")]
pub struct V3TargetExhaustion {
    pub route: Box<V3Router07OpaqueTargetHitOnce>,
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
    #[error("requested model {model_id} has no candidate in the selected target plan")]
    RequestedModelUnavailable { model_id: String },
    #[error("selected target has no concrete candidates")]
    CandidateSetEmpty,
}

#[derive(Debug, Clone, Default)]
pub struct V3TargetInterpreter {
    cursors: Arc<Mutex<BTreeMap<String, usize>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3TargetExpansionScope {
    path: Vec<String>,
    pool_ids: Vec<String>,
    default_pool_member: bool,
    required_capabilities: Vec<String>,
    requested_model_filter: Option<String>,
    visible_model_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3TargetContextAdmission {
    Normal,
    NearLimit,
    Exceeded {
        input_tokens: u64,
        max_context_tokens: u64,
    },
}

impl V3TargetInterpreter {
    pub fn resolve_exact_provider_model_auth(
        &self,
        manifest: &V3Config05ManifestPublished,
        provider_id: &str,
        model_id: &str,
        auth_alias: &str,
    ) -> Result<V3TargetCandidate, V3TargetError> {
        self.expand_provider(
            manifest,
            Some(provider_id),
            Some(model_id),
            Some(auth_alias),
            0,
            V3TargetExpansionScope {
                path: vec!["continuation:exact_pin".to_string()],
                pool_ids: vec!["continuation_exact_pin".to_string()],
                default_pool_member: false,
                required_capabilities: Vec::new(),
                requested_model_filter: None,
                visible_model_ids: Vec::new(),
            },
        )?
        .into_iter()
        .next()
        .ok_or(V3TargetError::CandidateSetEmpty)
    }

    pub fn classify_kind(&self, route: V3Router07OpaqueTargetHitOnce) -> V3Target08KindClassified {
        V3Target08KindClassified { route }
    }

    pub fn expand_candidates(
        &self,
        manifest: &V3Config05ManifestPublished,
        classified: V3Target08KindClassified,
        deterministic_sample: u64,
    ) -> Result<V3Target09CandidateSetExpanded, V3TargetError> {
        let group = manifest
            .route_groups
            .get(&classified.route.routing_group_id)
            .ok_or(V3TargetError::SelectedPoolMissing)?;
        let mut candidates = Vec::new();
        let mut candidate_indices = BTreeMap::new();
        let mut last_error = None;
        let route_required_capabilities =
            selected_route_required_capabilities(group, &classified.route);
        let requested_model_filter =
            selected_route_requested_model_filter(manifest, group, &classified.route);
        for (plan_index, entry) in classified.route.target_plan.iter().enumerate() {
            // `provider.model` direct entries carry their own provider/model
            // pin and have no manifest pool to consult.
            if let Some((provider_id, model_id)) = &entry.direct_provider_model {
                match self.expand_provider(
                    manifest,
                    Some(provider_id),
                    Some(model_id),
                    None,
                    deterministic_sample,
                    V3TargetExpansionScope {
                        path: vec![format!("direct:{provider_id}.{model_id}")],
                        pool_ids: vec![entry.pool_id.clone()],
                        default_pool_member: false,
                        required_capabilities: Vec::new(),
                        requested_model_filter: None,
                        visible_model_ids: Vec::new(),
                    },
                ) {
                    Ok(expanded) => {
                        for candidate in expanded {
                            let key = format!(
                                "{}:{}:{}",
                                candidate.provider_id, candidate.auth_alias, candidate.model_id
                            );
                            if let Some(index) = candidate_indices.get(&key).copied() {
                                merge_candidate_route_provenance(
                                    &mut candidates[index],
                                    &candidate,
                                );
                            } else {
                                candidate_indices.insert(key, candidates.len());
                                candidates.push(candidate);
                            }
                        }
                    }
                    Err(error) => {
                        last_error = Some(error);
                    }
                }
                continue;
            }
            let pool = group
                .pools
                .get(&entry.pool_id)
                .ok_or(V3TargetError::SelectedPoolMissing)?;
            let target = pool.targets.get(entry.target_index);
            let Some(target) = target else {
                last_error = Some(V3TargetError::OpaqueTargetMissing);
                continue;
            };
            let required_capabilities = route_required_capabilities.clone();
            let mut visited = BTreeSet::new();
            match self.expand_route_target(
                manifest,
                target,
                deterministic_sample.wrapping_add(plan_index as u64),
                &mut visited,
                V3TargetExpansionScope {
                    path: vec![format!("pool:{}", entry.pool_id)],
                    pool_ids: vec![entry.pool_id.clone()],
                    default_pool_member: entry.pool_id == "default",
                    required_capabilities,
                    requested_model_filter: requested_model_filter.clone(),
                    visible_model_ids: Vec::new(),
                },
            ) {
                Ok(expanded) => {
                    for candidate in expanded {
                        let key = format!(
                            "{}:{}:{}",
                            candidate.provider_id, candidate.auth_alias, candidate.model_id
                        );
                        if let Some(index) = candidate_indices.get(&key).copied() {
                            merge_candidate_route_provenance(&mut candidates[index], &candidate);
                        } else {
                            candidate_indices.insert(key, candidates.len());
                            candidates.push(candidate);
                        }
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }
        if candidates.is_empty() {
            return Err(last_error.unwrap_or(V3TargetError::CandidateSetEmpty));
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
        // An explicit `provider.model` pin is diagnostic intent (V2 semantics):
        // health cooldowns are reported but never veto the pinned provider.
        // Explicit exclusions still block via the exhaustion path below.
        let direct_route = expanded.route.pool_id == "direct";
        let mut direct_fallback: Option<(usize, V3TargetCandidate)> = None;
        for admission_class in [
            V3TargetContextAdmission::Normal,
            V3TargetContextAdmission::NearLimit,
        ] {
            for (index, candidate) in expanded.candidates.iter().enumerate() {
                if !candidate_satisfies_required_capabilities(candidate) {
                    if admission_class == V3TargetContextAdmission::Normal {
                        unavailable.push(format!(
                            "{}:{}:{}:capability_mismatch",
                            candidate.provider_id, candidate.auth_alias, candidate.model_id
                        ));
                    }
                    continue;
                }
                let context_admission =
                    candidate_context_admission(candidate, expanded.route.request_input_tokens);
                if let V3TargetContextAdmission::Exceeded {
                    input_tokens,
                    max_context_tokens,
                } = context_admission
                {
                    if admission_class == V3TargetContextAdmission::Normal {
                        unavailable.push(format!(
                            "{}:{}:{}:context_window_exceeded(input_tokens={},max_context_tokens={})",
                            candidate.provider_id,
                            candidate.auth_alias,
                            candidate.model_id,
                            input_tokens,
                            max_context_tokens
                        ));
                    }
                    continue;
                }
                if context_admission != admission_class {
                    continue;
                }
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
                        default_floor_protected: false,
                    });
                }
                if direct_route
                    && direct_fallback.is_none()
                    && !projection
                        .blocked_scopes
                        .iter()
                        .any(|scope| scope == "request_local_provider_failure")
                {
                    direct_fallback = Some((index, candidate.clone()));
                }
                unavailable.push(format_candidate_availability_unavailable(
                    candidate,
                    &projection,
                ));
            }
        }
        if let Some((index, candidate)) = direct_fallback {
            return Ok(V3Target10ConcreteProviderSelected {
                route: expanded.route,
                candidate,
                unavailable_candidates: unavailable,
                attempts: index + 1,
                default_floor_protected: false,
            });
        }
        Err(V3TargetExhaustion {
            route: Box::new(expanded.route),
            attempted_candidates: unavailable,
        })
    }

    fn expand_route_target(
        &self,
        manifest: &V3Config05ManifestPublished,
        target: &V3RoutePoolTargetManifest,
        sample: u64,
        visited: &mut BTreeSet<String>,
        scope: V3TargetExpansionScope,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        match target.kind {
            V3RouteTargetKind::ProviderModel => self.expand_provider(
                manifest,
                target.provider.as_deref(),
                target.model.as_deref(),
                target.key.as_deref(),
                sample,
                scope,
            ),
            V3RouteTargetKind::Forwarder => self.expand_forwarder(
                manifest,
                target
                    .id
                    .as_deref()
                    .ok_or(V3TargetError::ProviderTargetIncomplete)?,
                sample,
                visited,
                scope,
            ),
        }
    }

    fn expand_forwarder(
        &self,
        manifest: &V3Config05ManifestPublished,
        forwarder_id: &str,
        sample: u64,
        visited: &mut BTreeSet<String>,
        mut scope: V3TargetExpansionScope,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        if !visited.insert(forwarder_id.to_string()) {
            return Err(V3TargetError::ForwarderCycle(forwarder_id.to_string()));
        }
        scope.path.push(format!("forwarder:{forwarder_id}"));
        let forwarder = manifest
            .forwarders
            .get(forwarder_id)
            .filter(|forwarder| forwarder.enabled)
            .ok_or_else(|| V3TargetError::ForwarderMissing(forwarder_id.to_string()))?;
        // The forwarder model is the configured client-visible target identity. Validation
        // still happens at the provider layer after the nested wire model is resolved.
        // visible_model_ids must stay symmetric with `pool_targets_route_model`'s
        // Forwarder branch (forwarder.model / aliases / targets[].model); otherwise a
        // requested model matched by the route-model predicate is filtered out during
        // expansion and the selected target falsely exhausts into a no-candidate 503.
        push_unique_visible_model_id(&mut scope.visible_model_ids, &forwarder.model);
        for alias in &forwarder.aliases {
            push_unique_visible_model_id(&mut scope.visible_model_ids, alias);
        }
        for target in &forwarder.targets {
            if let Some(model) = target.model.as_deref() {
                push_unique_visible_model_id(&mut scope.visible_model_ids, model);
            }
        }
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
                    sample.wrapping_add(index as u64),
                    scope.clone(),
                ),
                V3RouteTargetKind::Forwarder => self.expand_forwarder(
                    manifest,
                    target
                        .id
                        .as_deref()
                        .ok_or(V3TargetError::ProviderTargetIncomplete)?,
                    sample.wrapping_add(index as u64),
                    visited,
                    scope.clone(),
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
        sample: u64,
        mut scope: V3TargetExpansionScope,
    ) -> Result<Vec<V3TargetCandidate>, V3TargetError> {
        let provider_id = provider_id.ok_or(V3TargetError::ProviderTargetIncomplete)?;
        let provider = manifest
            .providers
            .get(provider_id)
            .filter(|provider| provider.enabled)
            .ok_or_else(|| V3TargetError::ProviderMissing(provider_id.to_string()))?;
        let model_id = model_id.unwrap_or(&provider.default_model);
        let model = provider
            .models
            .get(model_id)
            .ok_or_else(|| V3TargetError::ModelMissing {
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
            })?;
        let visible_model_ids = if scope.visible_model_ids.is_empty() {
            normalized_model_visible_ids(&model.id, &model.aliases, Some(&model.wire_name))
        } else {
            scope.visible_model_ids.clone()
        };
        if !requested_model_matches_visible_ids(
            scope.requested_model_filter.as_deref(),
            &visible_model_ids,
        ) {
            return Err(requested_model_unavailable_error(
                scope.requested_model_filter.as_deref(),
            ));
        }
        scope.path.push(format!("provider:{provider_id}"));
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
            // 不指明 key：展开 provider 全部 auth entries（key1/key2/...）。
            // 同 priority 候选按序选第一个可用（select_available），若不轮换
            // 起点会永远命中第一个 key——用每请求 deterministic_sample
            // （request_id FNV hash）旋转展开起点，使多 key 轮流成为首选。
            let mut entries: Vec<_> = provider.auth.entries.iter().collect();
            let offset = (sample % entries.len() as u64) as usize;
            entries.rotate_left(offset);
            entries
        };
        Ok(entries
            .into_iter()
            .map(|entry| V3TargetCandidate {
                provider_id: provider_id.to_string(),
                provider_type: provider.provider_type.clone(),
                auth_alias: entry.alias.clone(),
                model_id: model.id.clone(),
                wire_model: model.wire_name.clone(),
                visible_model_ids: visible_model_ids.clone(),
                model_capabilities: model.capabilities.clone(),
                web_search_execution_mode: model.web_search_execution_mode,
                max_context_tokens: model.max_context_tokens,
                context_token_estimate_scale_bps: model.context_token_estimate_scale_bps,
                base_url: provider.base_url.clone(),
                responses_process: provider
                    .responses
                    .as_ref()
                    .map(|responses| responses.process.clone()),
                responses_transport: provider
                    .responses
                    .as_ref()
                    .map(|responses| responses.transport)
                    .unwrap_or_default(),
                websocket_v2_url: provider
                    .responses
                    .as_ref()
                    .and_then(|responses| responses.websocket_v2_url.clone()),
                provider_request_cleanup: provider.provider_request_cleanup.clone(),
                request_timeout_ms: provider.request_timeout_ms,
                initial_concurrency_budget: provider
                    .concurrency
                    .as_ref()
                    .map_or(8, |concurrency| concurrency.max_in_flight),
                compatibility_profile: provider.compatibility_profile.clone(),
                env_name: entry.env.clone(),
                token_file: entry.token_file.clone(),
                secret_file: entry.secret_file.clone(),
                secret_key: entry.secret_key.clone(),
                api_key: entry.api_key.clone(),
                required_capabilities: scope.required_capabilities.clone(),
                pool_ids: scope.pool_ids.clone(),
                default_pool_member: scope.default_pool_member,
                path: scope.path.clone(),
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
                order = priority_tier_indices(targets, |target| target.priority)
                    .into_iter()
                    .flatten()
                    .collect();
            }
            V3SelectionStrategy::Weighted => {
                order.clear();
                for mut tier in priority_tier_indices(targets, |target| target.priority) {
                    let total = tier
                        .iter()
                        .map(|index| u64::from(targets[*index].weight.unwrap_or(1)))
                        .sum::<u64>();
                    let mut point = sample % total;
                    let mut chosen = 0;
                    for (tier_index, target_index) in tier.iter().enumerate() {
                        let weight = u64::from(targets[*target_index].weight.unwrap_or(1));
                        if point < weight {
                            chosen = tier_index;
                            break;
                        }
                        point -= weight;
                    }
                    tier.rotate_left(chosen);
                    order.extend(tier);
                }
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

fn candidate_context_admission(
    candidate: &V3TargetCandidate,
    request_input_tokens: u64,
) -> V3TargetContextAdmission {
    let Some(max_context_tokens) = candidate.max_context_tokens else {
        return V3TargetContextAdmission::Normal;
    };
    let scaled_input_tokens = ((u128::from(request_input_tokens)
        * u128::from(candidate.context_token_estimate_scale_bps)
        + 9_999)
        / 10_000)
        .min(u128::from(u64::MAX)) as u64;
    if scaled_input_tokens > max_context_tokens {
        return V3TargetContextAdmission::Exceeded {
            input_tokens: scaled_input_tokens,
            max_context_tokens,
        };
    }
    if u128::from(scaled_input_tokens) * 100 >= u128::from(max_context_tokens) * 90 {
        return V3TargetContextAdmission::NearLimit;
    }
    V3TargetContextAdmission::Normal
}

fn selected_route_required_capabilities(
    group: &V3RouteGroupManifest,
    route: &V3Router07OpaqueTargetHitOnce,
) -> Vec<String> {
    let mut capabilities = BTreeSet::new();
    for capability in &route.request_capabilities {
        capabilities.insert(capability.clone());
    }
    for entry in &route.target_plan {
        if entry.pool_id == "default" {
            continue;
        }
        let Some(pool) = group.pools.get(&entry.pool_id) else {
            continue;
        };
        let Some(rule) = &pool.match_rule else {
            continue;
        };
        for capability in &rule.required_capabilities {
            capabilities.insert(capability.clone());
        }
    }
    capabilities.into_iter().collect()
}

fn selected_route_requested_model_filter(
    manifest: &V3Config05ManifestPublished,
    group: &V3RouteGroupManifest,
    route: &V3Router07OpaqueTargetHitOnce,
) -> Option<String> {
    let requested = route
        .request_client_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    // Only configured built-in Codex catalog models may use the legacy
    // requested-model exemption. Unknown gpt-* names must still be rejected.
    if is_v3_builtin_catalog_model(requested) {
        return None;
    }
    let pool = group.pools.get(&route.pool_id);
    let pool_is_explicit_model_pool = route.pool_id != "default"
        && pool
            .and_then(|pool| pool.match_rule.as_ref())
            .is_some_and(|rule| rule.models.iter().any(|model| model.trim() == requested));
    if pool_is_explicit_model_pool {
        return None;
    }
    if pool.is_some_and(|pool| pool_targets_route_model(manifest, pool, requested)) {
        Some(requested.to_string())
    } else {
        None
    }
}

fn pool_targets_route_model(
    manifest: &V3Config05ManifestPublished,
    pool: &V3RoutePoolManifest,
    requested: &str,
) -> bool {
    pool.targets.iter().any(|target| match target.kind {
        V3RouteTargetKind::ProviderModel => {
            target
                .model
                .as_deref()
                .is_some_and(|model| model.trim() == requested)
                || target.provider.as_deref().is_some_and(|provider_id| {
                    manifest.providers.get(provider_id).is_some_and(|provider| {
                        provider
                            .models
                            .values()
                            .any(|model| model_visible_name_matches(model, requested))
                    })
                })
        }
        V3RouteTargetKind::Forwarder => target
            .id
            .as_deref()
            .and_then(|id| manifest.forwarders.get(id))
            .is_some_and(|forwarder| {
                forwarder.model.trim() == requested
                    || forwarder
                        .aliases
                        .iter()
                        .any(|alias| alias.trim() == requested)
                    || forwarder.targets.iter().any(|target| {
                        target
                            .model
                            .as_deref()
                            .is_some_and(|model| model.trim() == requested)
                    })
            }),
    })
}

fn model_visible_name_matches(model: &V3ProviderModelManifest, requested: &str) -> bool {
    model.id == requested || model.aliases.iter().any(|alias| alias == requested)
}

fn normalized_model_visible_ids(
    model_id: &str,
    _aliases: &[String],
    wire_name: Option<&str>,
) -> Vec<String> {
    let mut ids = Vec::new();
    push_unique_visible_model_id(&mut ids, model_id);
    // wire_name is the upstream wire model identity: a client requesting the
    // wire name must be able to match this provider's model even when its
    // local model id differs (e.g. distinct web_search execution mode
    // profiles sharing the same upstream model).
    if let Some(wire_name) = wire_name {
        push_unique_visible_model_id(&mut ids, wire_name);
    }
    ids
}

fn push_unique_visible_model_id(ids: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() || ids.iter().any(|existing| existing == value) {
        return;
    }
    ids.push(value.to_string());
}

fn requested_model_matches_visible_ids(
    requested_model: Option<&str>,
    visible_model_ids: &[String],
) -> bool {
    let Some(requested_model) = requested_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    visible_model_ids
        .iter()
        .any(|visible_id| visible_id.trim() == requested_model)
}

fn requested_model_unavailable_error(requested_model: Option<&str>) -> V3TargetError {
    V3TargetError::RequestedModelUnavailable {
        model_id: requested_model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<unknown>")
            .to_string(),
    }
}

fn merge_candidate_route_provenance(
    existing: &mut V3TargetCandidate,
    duplicate: &V3TargetCandidate,
) {
    for pool_id in &duplicate.pool_ids {
        if !existing.pool_ids.iter().any(|existing| existing == pool_id) {
            existing.pool_ids.push(pool_id.clone());
        }
    }
    for capability in &duplicate.required_capabilities {
        if !existing
            .required_capabilities
            .iter()
            .any(|existing| existing == capability)
        {
            existing.required_capabilities.push(capability.clone());
        }
    }
    for visible_id in &duplicate.visible_model_ids {
        if !existing
            .visible_model_ids
            .iter()
            .any(|existing| existing == visible_id)
        {
            existing.visible_model_ids.push(visible_id.clone());
        }
    }
    existing.default_pool_member |= duplicate.default_pool_member;
}

fn candidate_satisfies_required_capabilities(candidate: &V3TargetCandidate) -> bool {
    candidate
        .required_capabilities
        .iter()
        .all(|required| candidate_has_required_capability(&candidate.model_capabilities, required))
}

fn candidate_has_required_capability(capabilities: &[String], required: &str) -> bool {
    let has = |wanted: &str| capabilities.iter().any(|capability| capability == wanted);
    match required {
        "search" | "web_search" => has("web_search"),
        "multimodal" | "vision" => has("multimodal") || has("vision"),
        _ => true,
    }
}

fn format_candidate_availability_unavailable(
    candidate: &V3TargetCandidate,
    projection: &routecodex_v3_provider_responses::V3ProviderAvailabilityProjection,
) -> String {
    let key = format!(
        "{}:{}:{}",
        candidate.provider_id, candidate.auth_alias, candidate.model_id
    );
    if projection.blocked_scopes.is_empty() {
        return key;
    }
    format!(
        "{}:availability({})",
        key,
        projection.blocked_scopes.join("|")
    )
}
