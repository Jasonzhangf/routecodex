use napi::Env;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use super::tier_load_balancing::{build_group_weights, resolve_tier_load_balancing};
use super::types::SelectionResult;
use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::classifier::{ClassificationResult, DEFAULT_ROUTE};
use crate::virtual_router_engine::error::{
    format_virtual_router_error, format_virtual_router_error_with_details,
};
use crate::virtual_router_engine::features::RoutingFeatures;
use crate::virtual_router_engine::instructions::RoutingInstructionState;
use crate::virtual_router_engine::quota::ProviderQuotaState;
use crate::virtual_router_engine::routing::{
    build_route_queue, default_pool_supports_capability, extract_excluded_provider_keys,
    extract_provider_id, filter_candidates_by_state, filter_pools_by_capability,
    resolve_instruction_target, route_has_targets,
};
use crate::virtual_router_engine::time_utils::now_ms;

const DEFAULT_MODEL_CONTEXT_TOKENS: i64 = 200_000;
const SINGLETON_RUST_QUOTA_RECOVERABLE_COOLDOWN_MS: i64 = 10_000;

fn read_requested_route_policy_group(metadata: &Value) -> Option<String> {
    metadata
        .get("routecodexRoutingPolicyGroup")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn pool_matches_route_policy_group(
    pool: &crate::virtual_router_engine::routing::RoutePoolTier,
    requested_group: Option<&str>,
) -> bool {
    let Some(requested_group) = requested_group
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    let pool_group = pool
        .route_params
        .as_ref()
        .and_then(|params| params.get("routePolicyGroup"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match pool_group {
        Some(value) => value == requested_group,
        // A requested routing policy group is a hard port-isolation boundary.
        // Untagged/global pools must not leak into a port-scoped route pool.
        None => false,
    }
}

fn resolve_route_pools_for_selection(
    routing: &crate::virtual_router_engine::routing::RoutingPools,
    route_name: &str,
    routing_group_prefix: Option<&String>,
) -> Vec<crate::virtual_router_engine::routing::RoutePoolTier> {
    if let Some(prefix) = routing_group_prefix {
        let routing_key = format!("{}{}", prefix, route_name);
        if let Some(pools) = routing.get_opt(&routing_key) {
            return pools.clone();
        }
    }
    if let Some(pools) = routing.get_opt(route_name) {
        return pools.clone();
    }
    let suffix = format!(":{}", route_name);
    let mut matches: Vec<_> = routing
        .keys()
        .filter(|key| !key.as_str().contains(':') || key.ends_with(&suffix))
        .filter(|key| key.ends_with(&suffix))
        .cloned()
        .collect();
    matches.sort();
    if matches.len() == 1 {
        return routing.get(matches[0].as_str());
    }
    Vec::new()
}

fn classify_context_candidates(
    provider_registry: &crate::virtual_router_engine::provider_registry::ProviderRegistry,
    provider_keys: &[String],
    estimated_tokens: i64,
    warn_ratio: f64,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    if estimated_tokens <= 0 {
        return (provider_keys.to_vec(), Vec::new(), Vec::new());
    }
    let mut safe = Vec::new();
    let mut risky = Vec::new();
    let mut overflow = Vec::new();
    for key in provider_keys {
        let limit = provider_registry
            .get(key)
            .and_then(|profile| profile.max_context_tokens)
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MODEL_CONTEXT_TOKENS);
        let ratio = estimated_tokens as f64 / limit as f64;
        if ratio < warn_ratio {
            safe.push(key.clone());
        } else if ratio < 1.0 {
            risky.push(key.clone());
        } else {
            overflow.push(key.clone());
        }
    }
    (safe, risky, overflow)
}

fn dedupe_candidate_order(candidates: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for candidate in candidates {
        if !candidate.trim().is_empty() && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

impl VirtualRouterEngineCore {
    /// Apply standard candidate filters: routing state, excluded keys, and provider availability.
    /// This is the single filter chain used by all selection paths (forced, prefer, pool).
    pub(crate) fn apply_standard_filters(
        &mut self,
        env: Env,
        candidates: &[String],
        routing_state: &RoutingInstructionState,
        excluded_keys: &HashSet<String>,
    ) -> Vec<String> {
        let filtered =
            filter_candidates_by_state(candidates, routing_state, &self.provider_registry);
        let route_candidates: Vec<String> = filtered
            .iter()
            .cloned()
            .filter(|key| !excluded_keys.contains(key))
            .collect();
        self.collect_available_candidates(env, &route_candidates)
    }

    fn collect_available_candidates(&mut self, env: Env, candidates: &[String]) -> Vec<String> {
        let route_candidates: Vec<String> = candidates.iter().cloned().collect();
        let now = now_ms();
        let mut available: Vec<String> = Vec::new();
        for key in &route_candidates {
            if self.is_provider_available(env, key)
                || self
                    .health_manager
                    .consume_persisted_503_reprobe_if_available(key, now)
            {
                available.push(key.clone());
            }
        }
        if available.is_empty() && route_candidates.len() == 1 {
            let provider_key = &route_candidates[0];
            if self.is_singleton_provider_soft_available_from_rust_quota(env, provider_key)
                || self
                    .health_manager
                    .consume_persisted_503_reprobe_if_available(provider_key, now)
            {
                available.push(provider_key.clone());
            }
        }
        available
    }

    pub(crate) fn select_provider(
        &mut self,
        requested_route: &str,
        metadata: &Value,
        classification: &ClassificationResult,
        features: &RoutingFeatures,
        routing_state: &RoutingInstructionState,
        bound_alias_prefix: Option<&str>,
        env: Env,
    ) -> Result<SelectionResult, String> {
        let excluded_keys: HashSet<String> = extract_excluded_provider_keys(metadata)
            .into_iter()
            .collect();

        if let Some(target) = &routing_state.forced_target {
            if let Some(resolved) = resolve_instruction_target(target, &self.provider_registry) {
                let available =
                    self.apply_standard_filters(env, &resolved.keys, routing_state, &excluded_keys);
                if let Some(forced_key) = available.into_iter().next() {
                    return Ok(SelectionResult::new(
                        forced_key.clone(),
                        requested_route.to_string(),
                        resolved.keys.clone(),
                        Some("forced".to_string()),
                    ));
                }
            }
        }

        let route_queue = build_route_queue(
            requested_route,
            &classification.candidates,
            features,
            &self.routing,
        );
        let requested_route_policy_group = read_requested_route_policy_group(metadata);
        let routing_group_prefix = requested_route_policy_group
            .as_deref()
            .map(|g| format!("{}:", g));
        let requires_remote_video = features.has_video_attachment
            && features.has_remote_video_attachment
            && route_has_targets(&self.routing, "video");
        let web_search_route_requested = classification.route_name == "web_search";
        let multimodal_route_requested = features.has_image_attachment;
        let has_explicit_web_search_route = route_has_targets(&self.routing, "web_search");
        let default_pool_supports_web_search =
            default_pool_supports_capability(&self.routing, &self.provider_registry, "web_search");
        let select_default_pool_for_web_search =
            web_search_route_requested && default_pool_supports_web_search;
        let select_default_pool_for_multimodal = multimodal_route_requested;
        let longcontext_candidate_active = requested_route == "longcontext"
            || classification
                .candidates
                .iter()
                .any(|candidate| candidate == "longcontext");
        let mut unavailable_route_pools: Vec<Value> = Vec::new();
        let mut all_candidate_keys: Vec<String> = Vec::new();

        for route_name in route_queue {
            let mut pools = if requires_remote_video {
                self.routing.get("video")
            } else if web_search_route_requested
                && route_name == "web_search"
                && has_explicit_web_search_route
            {
                self.routing.get("web_search")
            } else if web_search_route_requested
                && route_name == DEFAULT_ROUTE
                && select_default_pool_for_web_search
            {
                self.routing.get(DEFAULT_ROUTE)
            } else if multimodal_route_requested
                && route_name == DEFAULT_ROUTE
                && select_default_pool_for_multimodal
            {
                self.routing.get(DEFAULT_ROUTE)
            } else {
                resolve_route_pools_for_selection(
                    &self.routing,
                    &route_name,
                    routing_group_prefix.as_ref(),
                )
            };
            if web_search_route_requested
                && route_name == DEFAULT_ROUTE
                && select_default_pool_for_web_search
            {
                pools = filter_pools_by_capability(&pools, &self.provider_registry, "web_search");
            }
            if web_search_route_requested
                && (route_name == "web_search" || route_name == DEFAULT_ROUTE)
            {
                let capability_filtered =
                    filter_pools_by_capability(&pools, &self.provider_registry, "web_search");
                if !capability_filtered.is_empty() {
                    pools = capability_filtered;
                }
            }
            if multimodal_route_requested
                && (route_name == "multimodal" || route_name == DEFAULT_ROUTE)
            {
                let capability_filtered =
                    filter_pools_by_capability(&pools, &self.provider_registry, "multimodal");
                if !capability_filtered.is_empty() {
                    pools = capability_filtered;
                } else if select_default_pool_for_multimodal && route_name == "multimodal" {
                    continue;
                }
            }
            for pool in pools {
                if !pool_matches_route_policy_group(&pool, requested_route_policy_group.as_deref())
                {
                    continue;
                }
                if pool.targets.is_empty() {
                    continue;
                }
                for key in &pool.targets {
                    if !all_candidate_keys.contains(key) {
                        all_candidate_keys.push(key.clone());
                    }
                }
                let mut available =
                    self.apply_standard_filters(env, &pool.targets, routing_state, &excluded_keys);
                if let Some(prefix) = bound_alias_prefix {
                    let alias_candidates: Vec<String> = available
                        .iter()
                        .filter(|key| key.starts_with(prefix))
                        .cloned()
                        .collect();
                    if !alias_candidates.is_empty() {
                        available = alias_candidates;
                    }
                }
                if longcontext_candidate_active {
                    let (safe_context, risky_context, overflow_context) =
                        classify_context_candidates(
                            &self.provider_registry,
                            &available,
                            features.estimated_tokens,
                            self.context_warn_ratio,
                        );
                    if !safe_context.is_empty() {
                        available = safe_context;
                    } else if !risky_context.is_empty() {
                        available = risky_context;
                    } else if self.context_hard_limit || longcontext_candidate_active {
                        continue;
                    } else if !overflow_context.is_empty() {
                        available = overflow_context;
                    }
                }
                if available.is_empty() {
                    let filtered_candidates = filter_candidates_by_state(
                        &pool.targets,
                        routing_state,
                        &self.provider_registry,
                    )
                    .into_iter()
                    .filter(|key| !excluded_keys.contains(key))
                    .collect::<Vec<String>>();
                    if !filtered_candidates.is_empty() {
                        if let Some(unavailable) =
                            build_unavailable_providers_details(self, env, &filtered_candidates)
                        {
                            unavailable_route_pools.push(json!({
                                "routeName": route_name,
                                "poolId": pool.id,
                                "poolTargets": pool.targets,
                                "unavailableProviders": unavailable
                            }));
                        }
                    }
                    continue;
                }
                let tier_load_balancing =
                    resolve_tier_load_balancing(&pool, self.load_balancer.policy());
                let route_key_for_lb = route_name.to_string();
                let (ordered_group_ids, grouped_candidates) =
                    build_primary_target_groups(&available, &self.provider_registry);
                let strategy = tier_load_balancing.strategy.as_str();
                let selected_candidates = match strategy {
                    "priority" => available.clone(),
                    "weighted" if !ordered_group_ids.is_empty() => {
                        let group_weights = build_group_weights(
                            &grouped_candidates,
                            tier_load_balancing.weights.as_ref(),
                        );
                        self.load_balancer
                            .select_grouped(
                                &route_key_for_lb,
                                &ordered_group_ids,
                                &grouped_candidates,
                                group_weights.as_ref(),
                                |_| true,
                                Some("weighted"),
                            )
                            .into_iter()
                            .chain(available.iter().cloned())
                            .collect::<Vec<String>>()
                    }
                    "round-robin" if !ordered_group_ids.is_empty() => self
                        .load_balancer
                        .select_grouped(
                            &route_key_for_lb,
                            &ordered_group_ids,
                            &grouped_candidates,
                            None,
                            |_| true,
                            Some("round-robin"),
                        )
                        .into_iter()
                        .chain(available.iter().cloned())
                        .collect::<Vec<String>>(),
                    _ => self
                        .load_balancer
                        .select_grouped(
                            &route_key_for_lb,
                            &ordered_group_ids,
                            &grouped_candidates,
                            None,
                            |_| true,
                            Some("round-robin"),
                        )
                        .into_iter()
                        .chain(available.iter().cloned())
                        .collect::<Vec<String>>(),
                };

                for key in dedupe_candidate_order(selected_candidates) {
                    let resolved_key = if crate::virtual_router_engine::forwarder::ForwarderRegistry::is_forwarder_id(
                        &key,
                    ) {
                        // Pre-collect (clone out targets, then drop borrow) so we can call mutating self
                        let cloned_targets: Vec<
                            crate::virtual_router_engine::forwarder::ForwarderTarget,
                        > = self
                            .forwarder_registry
                            .get(&key)
                            .map(|e| e.targets.clone())
                            .unwrap_or_default();
                        let mut available_real_keys: std::collections::HashSet<String> =
                            std::collections::HashSet::new();
                        for target in &cloned_targets {
                            if !target.disabled
                                && !excluded_keys.contains(&target.provider_key)
                                && self.is_provider_available(env, &target.provider_key)
                            {
                                available_real_keys.insert(target.provider_key.clone());
                            }
                        }
                        match self.forwarder_registry.select(
                            &key,
                            &mut self.load_balancer,
                            |k: &str| available_real_keys.contains(k),
                            None,
                        ) {
                            Ok(real) => Some(real),
                            Err(e) if e == crate::virtual_router_engine::forwarder::ERR_FORWARDER_NO_AVAILABLE_TARGET => {
                                unavailable_route_pools.push(json!({
                                    "routeName": route_name,
                                    "poolId": pool.id,
                                    "poolTargets": pool.targets,
                                    "unavailableProviders": {
                                        "candidateProviderKeys": [key.clone()],
                                        "items": [{
                                            "providerKey": key.clone(),
                                            "reasons": [{
                                                "type": "forwarder_no_available_target",
                                                "code": e
                                            }]
                                        }]
                                    }
                                }));
                                None
                            }
                            Err(e) => {
                                unavailable_route_pools.push(json!({
                                    "routeName": route_name,
                                    "poolId": pool.id,
                                    "poolTargets": pool.targets,
                                    "unavailableProviders": {
                                        "candidateProviderKeys": [key.clone()],
                                        "items": [{
                                            "providerKey": key.clone(),
                                            "reasons": [{
                                                "type": "forwarder_selection_error",
                                                "message": e
                                            }]
                                        }]
                                    }
                                }));
                                None
                            }
                        }
                    } else {
                        Some(key)
                    };

                    if let Some(provider_key) = resolved_key {
                        return Ok(SelectionResult::new(
                            provider_key,
                            route_name.to_string(),
                            pool.targets.clone(),
                            Some(pool.id.clone()),
                        )
                        .with_route_params(pool.route_params.clone())
                        .with_unavailable_providers(
                            (!unavailable_route_pools.is_empty())
                                .then_some(Value::Array(unavailable_route_pools)),
                        ));
                    }
                }
            }
        }

        Err(build_provider_not_available_error(
            self,
            env,
            &all_candidate_keys,
            "No available providers after applying routing instructions",
        ))
    }

    pub(crate) fn is_provider_available(&mut self, env: Env, provider_key: &str) -> bool {
        if self
            .concurrency_busy_remaining_for_provider(provider_key, now_ms())
            .is_some()
        {
            return false;
        }
        if let Some(profile) = self.provider_registry.get(provider_key) {
            if !profile.enabled {
                return false;
            }
        }
        let now = now_ms();
        if let Some(state) = self.quota_manager.active_blocker(provider_key, now) {
            if quota_state_blocks_provider(&state, now) {
                return false;
            }
        }
        self.health_manager.is_available(provider_key, now)
    }

    pub(crate) fn is_singleton_provider_soft_available_from_rust_quota(
        &mut self,
        env: Env,
        provider_key: &str,
    ) -> bool {
        if self
            .concurrency_busy_remaining_for_provider(provider_key, now_ms())
            .is_some()
        {
            return false;
        }
        if let Some(profile) = self.provider_registry.get(provider_key) {
            if !profile.enabled {
                return false;
            }
        }
        let now = now_ms();
        let Some(state) = self.quota_manager.active_blocker(provider_key, now) else {
            return false;
        };
        if !supports_singleton_rust_quota_recovery(&state) {
            return false;
        }
        if !self.health_manager.is_available(provider_key, now) {
            return false;
        }
        singleton_rust_quota_recoverable_wait_ms(&state, now).is_none()
    }
}

fn build_unavailable_providers_details(
    core: &VirtualRouterEngineCore,
    env: Env,
    candidate_keys: &[String],
) -> Option<Value> {
    if candidate_keys.is_empty() {
        return None;
    }
    let now_ms = now_ms();
    let mut blockers: Vec<ProviderUnavailableBlocker> = Vec::new();
    let mut min_recoverable_cooldown_ms: Option<i64> = None;
    let mut hints: Vec<RecoverableCooldownHint> = Vec::new();
    for provider_key in candidate_keys {
        collect_recoverable_cooldown_for_key(
            core,
            env,
            provider_key,
            now_ms,
            candidate_keys.len(),
            &mut min_recoverable_cooldown_ms,
            &mut hints,
            &mut blockers,
        );
    }
    if blockers.is_empty() {
        return None;
    }
    Some(json!({
        "candidateProviderKeys": candidate_keys,
        "minRecoverableCooldownMs": min_recoverable_cooldown_ms,
        "recoverableCooldownHints": hints
            .into_iter()
            .map(|item| json!({
                "providerKey": item.provider_key,
                "waitMs": item.wait_ms,
                "source": item.source
            }))
            .collect::<Vec<Value>>(),
        "items": blockers
            .into_iter()
            .map(|item| json!({
                "providerKey": item.provider_key,
                "reasons": item.reasons
            }))
            .collect::<Vec<Value>>()
    }))
}

fn build_primary_target_groups(
    candidates: &[String],
    provider_registry: &crate::virtual_router_engine::provider_registry::ProviderRegistry,
) -> (Vec<String>, HashMap<String, Vec<String>>) {
    let mut ordered_group_ids = Vec::new();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();

    for key in candidates {
        let provider_id = extract_provider_id(key).unwrap_or_default();
        if provider_id.is_empty() {
            continue;
        }
        let model_id = provider_registry
            .get(key)
            .and_then(|profile| profile.model_id.clone())
            .filter(|value| !value.trim().is_empty());
        let group_id = model_id
            .map(|model_id| format!("{}.{}", provider_id, model_id))
            .unwrap_or_else(|| provider_id.to_string());
        if !groups.contains_key(&group_id) {
            ordered_group_ids.push(group_id.clone());
            groups.insert(group_id.clone(), Vec::new());
        }
        if let Some(entry) = groups.get_mut(&group_id) {
            entry.push(key.clone());
        }
    }

    (ordered_group_ids, groups)
}

#[derive(Debug, Clone)]
struct RecoverableCooldownHint {
    provider_key: String,
    wait_ms: i64,
    source: &'static str,
}

#[derive(Debug, Clone)]
struct ProviderUnavailableBlocker {
    provider_key: String,
    reasons: Vec<Value>,
}

fn supports_singleton_rust_quota_recovery(state: &ProviderQuotaState) -> bool {
    state.reason == "quotaDepleted" && state.blacklist_until.is_none()
}

fn singleton_rust_quota_recoverable_wait_ms(
    state: &ProviderQuotaState,
    now_ms: i64,
) -> Option<i64> {
    if !supports_singleton_rust_quota_recovery(state) {
        return None;
    }
    let active_until = state.cooldown_until.or(state.reset_at)?;
    if active_until <= now_ms {
        return None;
    }
    let softened_until = state
        .last_error_at_ms
        .map(|last_error_at| last_error_at + SINGLETON_RUST_QUOTA_RECOVERABLE_COOLDOWN_MS)
        .unwrap_or(active_until)
        .min(active_until);
    if softened_until <= now_ms {
        return None;
    }
    Some(softened_until - now_ms)
}

fn record_recoverable_cooldown(
    provider_key: &str,
    wait_ms_raw: i64,
    source: &'static str,
    min_recoverable_cooldown_ms: &mut Option<i64>,
    hints: &mut Vec<RecoverableCooldownHint>,
) {
    let wait_ms = wait_ms_raw.max(1);
    match min_recoverable_cooldown_ms {
        Some(current) if wait_ms < *current => *min_recoverable_cooldown_ms = Some(wait_ms),
        None => *min_recoverable_cooldown_ms = Some(wait_ms),
        _ => {}
    }

    if let Some(existing) = hints
        .iter_mut()
        .find(|item| item.provider_key == provider_key && item.source == source)
    {
        if wait_ms < existing.wait_ms {
            existing.wait_ms = wait_ms;
        }
        return;
    }
    hints.push(RecoverableCooldownHint {
        provider_key: provider_key.to_string(),
        wait_ms,
        source,
    });
}

fn push_unavailable_reason(
    blockers: &mut Vec<ProviderUnavailableBlocker>,
    provider_key: &str,
    reason: Value,
) {
    if let Some(existing) = blockers
        .iter_mut()
        .find(|item| item.provider_key == provider_key)
    {
        existing.reasons.push(reason);
        return;
    }
    blockers.push(ProviderUnavailableBlocker {
        provider_key: provider_key.to_string(),
        reasons: vec![reason],
    });
}

fn collect_recoverable_cooldown_for_key(
    core: &VirtualRouterEngineCore,
    env: Env,
    provider_key: &str,
    now_ms: i64,
    candidate_keys_len: usize,
    min_recoverable_cooldown_ms: &mut Option<i64>,
    hints: &mut Vec<RecoverableCooldownHint>,
    blockers: &mut Vec<ProviderUnavailableBlocker>,
) {
    if let Some(wait_ms) = core.concurrency_busy_remaining_for_provider(provider_key, now_ms) {
        record_recoverable_cooldown(
            provider_key,
            wait_ms,
            "concurrency.busy",
            min_recoverable_cooldown_ms,
            hints,
        );
        push_unavailable_reason(
            blockers,
            provider_key,
            json!({
                "type": "concurrency_busy",
                "waitMs": wait_ms
            }),
        );
    }

    if let Some(profile) = core.provider_registry.get(provider_key) {
        if !profile.enabled {
            push_unavailable_reason(
                blockers,
                provider_key,
                json!({
                    "type": "provider_disabled"
                }),
            );
        }
    }

    if let Some(state) = core.quota_manager.active_blocker(provider_key, now_ms) {
        if let Some(blacklist_until) = state.blacklist_until {
            push_unavailable_reason(
                blockers,
                provider_key,
                json!({
                    "type": "rust_quota_blacklist",
                    "until": blacklist_until,
                    "reason": state.reason
                }),
            );
            return;
        }
        let singleton_wait_ms = if candidate_keys_len == 1 {
            singleton_rust_quota_recoverable_wait_ms(&state, now_ms)
        } else {
            None
        };
        let rust_quota_until = state.cooldown_until.or(state.reset_at);
        if let Some(cooldown_until) = rust_quota_until {
            if cooldown_until > now_ms {
                let wait_ms = singleton_wait_ms.unwrap_or(cooldown_until - now_ms);
                record_recoverable_cooldown(
                    provider_key,
                    wait_ms,
                    "rust.quota",
                    min_recoverable_cooldown_ms,
                    hints,
                );
                push_unavailable_reason(
                    blockers,
                    provider_key,
                    json!({
                        "type": "rust_quota_cooldown",
                        "until": cooldown_until,
                        "waitMs": wait_ms,
                        "reason": state.reason,
                        "resetAt": state.reset_at,
                        "softenedForSingleton": singleton_wait_ms.is_some()
                    }),
                );
                return;
            }
        }
        if !state.in_pool {
            if candidate_keys_len == 1 && supports_singleton_rust_quota_recovery(&state) {
                return;
            }
            push_unavailable_reason(
                blockers,
                provider_key,
                json!({
                    "type": "rust_quota_out_of_pool",
                    "reason": state.reason,
                    "cooldownUntil": state.cooldown_until,
                    "blacklistUntil": state.blacklist_until,
                    "resetAt": state.reset_at
                }),
            );
            return;
        }
    }

    if let Some(wait_ms) = core
        .health_manager
        .cooldown_remaining_ms(provider_key, now_ms)
    {
        record_recoverable_cooldown(
            provider_key,
            wait_ms,
            "health.cooldown",
            min_recoverable_cooldown_ms,
            hints,
        );
        push_unavailable_reason(
            blockers,
            provider_key,
            json!({
                "type": "health_cooldown",
                "waitMs": wait_ms,
                "state": core.health_manager.describe_state(provider_key)
            }),
        );
    } else if let Some(state) = core.health_manager.describe_state(provider_key) {
        if state
            .get("state")
            .and_then(|v| v.as_str())
            .map(|v| v != "healthy")
            .unwrap_or(false)
        {
            push_unavailable_reason(
                blockers,
                provider_key,
                json!({
                    "type": "health_unavailable",
                    "state": state
                }),
            );
        }
    }
}

fn quota_state_blocks_provider(state: &ProviderQuotaState, now_ms: i64) -> bool {
    if state
        .blacklist_until
        .map(|until| until > now_ms)
        .unwrap_or(false)
    {
        return true;
    }
    if state
        .cooldown_until
        .or(state.reset_at)
        .map(|until| until > now_ms)
        .unwrap_or(false)
        && !state.in_pool
    {
        return true;
    }
    !state.in_pool && state.reason != "active"
}

pub(crate) fn build_provider_not_available_error(
    core: &VirtualRouterEngineCore,
    env: Env,
    candidate_keys: &[String],
    message: impl AsRef<str>,
) -> String {
    let now_ms = now_ms();
    let mut min_recoverable_cooldown_ms: Option<i64> = None;
    let mut hints: Vec<RecoverableCooldownHint> = Vec::new();
    let mut blockers: Vec<ProviderUnavailableBlocker> = Vec::new();

    for provider_key in candidate_keys {
        collect_recoverable_cooldown_for_key(
            core,
            env,
            provider_key,
            now_ms,
            candidate_keys.len(),
            &mut min_recoverable_cooldown_ms,
            &mut hints,
            &mut blockers,
        );
    }

    if let Some(min_wait_ms) = min_recoverable_cooldown_ms {
        let has_concurrency_busy = hints.iter().any(|item| item.source == "concurrency.busy");
        let mut sorted_hints = hints;
        sorted_hints.sort_by_key(|item| item.wait_ms);
        let details = json!({
            "status": 429,
            "statusCode": 429,
            "retryable": true,
            "retryAfterMs": min_wait_ms,
            "minRecoverableCooldownMs": min_wait_ms,
            "candidateProviderCount": candidate_keys.len(),
            "candidateProviderKeys": candidate_keys,
            "recoverableCooldownHints": sorted_hints
                .into_iter()
                .take(8)
                .map(|item| json!({
                    "providerKey": item.provider_key,
                    "waitMs": item.wait_ms,
                    "source": item.source,
                }))
                .collect::<Vec<Value>>(),
            "unavailableProviders": blockers
                .into_iter()
                .map(|item| json!({
                    "providerKey": item.provider_key,
                    "reasons": item.reasons
                }))
                .collect::<Vec<Value>>()
        });
        return format_virtual_router_error_with_details(
            "HTTP_429",
            if has_concurrency_busy {
                format!(
                    "Route providers are temporarily busy; retry after {}ms",
                    min_wait_ms
                )
            } else {
                format!(
                    "Route providers are temporarily unavailable; retry after {}ms",
                    min_wait_ms
                )
            },
            &details,
        );
    }

    if !blockers.is_empty() {
        let details = json!({
            "candidateProviderCount": candidate_keys.len(),
            "candidateProviderKeys": candidate_keys,
            "unavailableProviders": blockers
                .into_iter()
                .map(|item| json!({
                    "providerKey": item.provider_key,
                    "reasons": item.reasons
                }))
                .collect::<Vec<Value>>()
        });
        return format_virtual_router_error_with_details(
            "PROVIDER_NOT_AVAILABLE",
            message,
            &details,
        );
    }

    format_virtual_router_error("PROVIDER_NOT_AVAILABLE", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::engine::VirtualRouterEngineCore;
    use crate::virtual_router_engine::features::RoutingFeatures;
    use crate::virtual_router_engine::routing::{parse_routing, RoutePoolTier};
    use serde_json::{json, Map, Value};

    fn build_priority_test_core() -> VirtualRouterEngineCore {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        providers.insert(
            "sdfv.key1.gpt-5.4".to_string(),
            json!({
                "providerKey": "sdfv.key1.gpt-5.4",
                "providerType": "openai",
                "modelId": "gpt-5.4",
                "enabled": true
            }),
        );
        providers.insert(
            "mimo.key1.mimo-v2.5-pro".to_string(),
            json!({
                "providerKey": "mimo.key1.mimo-v2.5-pro",
                "providerType": "openai",
                "modelId": "mimo-v2.5-pro",
                "enabled": true
            }),
        );
        core.provider_registry.load(&providers);

        let routing = Map::from_iter([(
            "thinking".to_string(),
            Value::Array(vec![json!({
                "id": "gateway-priority-5555-thinking",
                "priority": 100,
                "mode": "priority",
                "targets": ["sdfv.key1.gpt-5.4", "mimo.key1.mimo-v2.5-pro"]
            })]),
        )]);
        core.routing = parse_routing(&routing);
        let keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&keys);
        core.quota_manager.register_providers(&keys);
        core
    }

    #[test]
    fn priority_pool_picks_primary_provider_when_both_available() {
        let mut core = build_priority_test_core();
        let classification = ClassificationResult {
            route_name: "thinking".to_string(),
            confidence: 1.0,
            reasoning: "test".to_string(),
            candidates: vec!["thinking".to_string()],
        };
        let features = RoutingFeatures::default();
        let routing_state = RoutingInstructionState::default();

        let selected = core
            .select_provider(
                "thinking",
                &json!({}),
                &classification,
                &features,
                &routing_state,
                None,
                unsafe { Env::from_raw(std::ptr::null_mut()) },
            )
            .expect("selection should succeed");
        assert_eq!(selected.provider_key, "sdfv.key1.gpt-5.4");
    }

    #[test]
    fn priority_pool_falls_back_to_backup_when_primary_in_health_cooldown() {
        let mut core = build_priority_test_core();
        let now = now_ms();
        core.health_manager
            .cooldown_provider_until_midnight_persisted("sdfv.key1.gpt-5.4", now, now + 60_000);

        let classification = ClassificationResult {
            route_name: "thinking".to_string(),
            confidence: 1.0,
            reasoning: "test".to_string(),
            candidates: vec!["thinking".to_string()],
        };
        let features = RoutingFeatures::default();
        let routing_state = RoutingInstructionState::default();

        let selected = core
            .select_provider(
                "thinking",
                &json!({}),
                &classification,
                &features,
                &routing_state,
                None,
                unsafe { Env::from_raw(std::ptr::null_mut()) },
            )
            .expect("selection should succeed");
        assert_eq!(selected.provider_key, "mimo.key1.mimo-v2.5-pro");
    }

    #[test]
    fn routing_exclusions_return_provider_not_available_when_all_targets_excluded() {
        let mut core = build_priority_test_core();
        let classification = ClassificationResult {
            route_name: "thinking".to_string(),
            confidence: 1.0,
            reasoning: "test".to_string(),
            candidates: vec!["thinking".to_string()],
        };
        let features = RoutingFeatures::default();
        let routing_state = RoutingInstructionState::default();

        let error = core
            .select_provider(
                "thinking",
                &json!({
                    "excludedProviderKeys": [
                        "sdfv.key1.gpt-5.4",
                        "mimo.key1.mimo-v2.5-pro"
                    ]
                }),
                &classification,
                &features,
                &routing_state,
                None,
                unsafe { Env::from_raw(std::ptr::null_mut()) },
            )
            .expect_err("all excluded targets must not be selected again");

        assert!(error.contains("PROVIDER_NOT_AVAILABLE"));
    }

    #[test]
    fn longcontext_active_does_not_fall_back_to_overflow_default_provider() {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        providers.insert(
            "big.mimo-pro".to_string(),
            json!({
                "providerKey": "big.mimo-pro",
                "providerType": "openai",
                "modelId": "mimo-pro",
                "enabled": true,
                "maxContextTokens": 100
            }),
        );
        providers.insert(
            "small.mini".to_string(),
            json!({
                "providerKey": "small.mini",
                "providerType": "openai",
                "modelId": "mini",
                "enabled": true,
                "maxContextTokens": 200
            }),
        );
        core.provider_registry.load(&providers);
        core.context_warn_ratio = 0.9;
        core.context_hard_limit = false;

        let routing = Map::from_iter([
            (
                "longcontext".to_string(),
                Value::Array(vec![json!({
                    "id": "longcontext",
                    "priority": 100,
                    "mode": "priority",
                    "targets": ["big.mimo-pro"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![json!({
                    "id": "default",
                    "priority": 100,
                    "mode": "priority",
                    "targets": ["small.mini"]
                })]),
            ),
        ]);
        core.routing = parse_routing(&routing);
        let keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&keys);
        core.quota_manager.register_providers(&keys);

        let features = RoutingFeatures {
            estimated_tokens: 250,
            ..RoutingFeatures::default()
        };
        let result = core.select_provider(
            "longcontext",
            &json!({}),
            &ClassificationResult {
                route_name: "longcontext".to_string(),
                confidence: 1.0,
                reasoning: "longcontext:token-threshold".to_string(),
                candidates: vec!["longcontext".to_string(), "default".to_string()],
            },
            &features,
            &RoutingInstructionState::default(),
            None,
            unsafe { Env::from_raw(std::ptr::null_mut()) },
        );

        assert!(
            result.is_err(),
            "longcontext overflow must not be silently served by default overflow provider"
        );
    }

    #[test]
    fn singleton_provider_with_active_503_health_cooldown_stays_filtered_until_startup_import_probe(
    ) {
        let provider_key = "windsurf.managed.gpt-5.5-low";
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        providers.insert(
            provider_key.to_string(),
            json!({
                "providerKey": provider_key,
                "providerType": "openai",
                "modelId": "gpt-5.5-low",
                "enabled": true
            }),
        );
        core.provider_registry.load(&providers);

        let routing = Map::from_iter([(
            "thinking".to_string(),
            Value::Array(vec![json!({
                "id": "gateway-priority-5520-thinking",
                "priority": 100,
                "mode": "round-robin",
                "targets": [provider_key]
            })]),
        )]);
        core.routing = parse_routing(&routing);
        let keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&keys);
        core.quota_manager.register_providers(&keys);
        let now = now_ms();
        core.health_manager
            .cooldown_provider_until_midnight_persisted(provider_key, now, now + 60_000);

        assert_eq!(
            core.apply_standard_filters(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &[provider_key.to_string()],
                &RoutingInstructionState::default(),
                &std::collections::HashSet::new(),
            ),
            Vec::<String>::new()
        );

        let selected = core.select_provider(
            "thinking",
            &json!({}),
            &ClassificationResult {
                route_name: "thinking".to_string(),
                confidence: 1.0,
                reasoning: "test".to_string(),
                candidates: vec!["thinking".to_string()],
            },
            &RoutingFeatures::default(),
            &RoutingInstructionState::default(),
            None,
            unsafe { Env::from_raw(std::ptr::null_mut()) },
        );

        assert!(
            selected.is_err(),
            "runtime active 503 cooldown must stay out of the routing pool until startup import grants a passive reprobe"
        );
    }

    #[test]
    fn weighted_selection_distributes_across_providers() {
        let mut core = build_priority_test_core();
        // Add weighted routing
        let routing = Map::from_iter([(
            "default".to_string(),
            Value::Array(vec![json!({
                "id": "default-weighted",
                "priority": 100,
                "mode": "weighted",
                "targets": ["sdfv.key1.gpt-5.4", "mimo.key1.mimo-v2.5-pro"],
                "loadBalancing": { "strategy": "weighted" }
            })]),
        )]);
        core.routing = parse_routing(&routing);

        let classification = ClassificationResult {
            route_name: "default".to_string(),
            confidence: 1.0,
            reasoning: "test".to_string(),
            candidates: vec!["default".to_string()],
        };
        let features = RoutingFeatures::default();
        let routing_state = RoutingInstructionState::default();

        // Run selection multiple times - should get valid provider each time
        for _ in 0..10 {
            let selected = core
                .select_provider(
                    "default",
                    &json!({}),
                    &classification,
                    &features,
                    &routing_state,
                    None,
                    unsafe { Env::from_raw(std::ptr::null_mut()) },
                )
                .expect("selection should succeed");
            assert!(
                selected.provider_key == "sdfv.key1.gpt-5.4"
                    || selected.provider_key == "mimo.key1.mimo-v2.5-pro"
            );
        }
    }

    #[test]
    fn select_provider_returns_error_when_no_providers_available() {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        providers.insert(
            "test.key1.model".to_string(),
            json!({
                "providerKey": "test.key1.model",
                "providerType": "openai",
                "modelId": "model",
                "enabled": false
            }),
        );
        core.provider_registry.load(&providers);
        core.health_manager
            .register_providers(&core.provider_registry.list_keys());

        let routing = Map::from_iter([(
            "default".to_string(),
            Value::Array(vec![json!({
                "id": "default-pool",
                "priority": 100,
                "targets": ["test.key1.model"]
            })]),
        )]);
        core.routing = parse_routing(&routing);

        let classification = ClassificationResult {
            route_name: "default".to_string(),
            confidence: 1.0,
            reasoning: "test".to_string(),
            candidates: vec!["default".to_string()],
        };
        let features = RoutingFeatures::default();
        let routing_state = RoutingInstructionState::default();

        let result = core.select_provider(
            "default",
            &json!({}),
            &classification,
            &features,
            &routing_state,
            None,
            unsafe { Env::from_raw(std::ptr::null_mut()) },
        );
        // Should fail because no providers are available
        assert!(result.is_err());
    }

    #[test]
    fn select_provider_falls_to_next_priority_pool_when_current_pool_is_cooled_down() {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        for key in ["primary.key1.model", "backup.key1.model"] {
            providers.insert(
                key.to_string(),
                json!({
                    "providerKey": key,
                    "providerType": "openai",
                    "modelId": "model",
                    "enabled": true
                }),
            );
        }
        core.provider_registry.load(&providers);
        let keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&keys);
        core.quota_manager.register_providers(&keys);
        core.health_manager
            .cooldown_provider("primary.key1.model", Some("HTTP_502".to_string()), Some(30 * 60_000), now_ms());

        let routing = Map::from_iter([(
            "thinking".to_string(),
            Value::Array(vec![
                json!({
                    "id": "thinking-primary",
                    "priority": 200,
                    "mode": "priority",
                    "targets": ["primary.key1.model"]
                }),
                json!({
                    "id": "thinking-backup",
                    "priority": 100,
                    "mode": "priority",
                    "targets": ["backup.key1.model"]
                }),
            ]),
        )]);
        core.routing = parse_routing(&routing);

        let selected = core
            .select_provider(
                "thinking",
                &json!({}),
                &ClassificationResult {
                    route_name: "thinking".to_string(),
                    confidence: 1.0,
                    reasoning: "thinking:user-input".to_string(),
                    candidates: vec!["thinking".to_string(), "default".to_string()],
                },
                &RoutingFeatures::default(),
                &RoutingInstructionState::default(),
                None,
                unsafe { Env::from_raw(std::ptr::null_mut()) },
            )
            .expect("backup pool should be selected");

        assert_eq!(selected.provider_key, "backup.key1.model");
        assert_eq!(selected.pool_id.as_deref(), Some("thinking-backup"));
    }

    #[test]
    fn select_provider_falls_to_next_priority_pool_when_current_pool_is_excluded() {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        for key in ["primary.key1.model", "backup.key1.model"] {
            providers.insert(
                key.to_string(),
                json!({
                    "providerKey": key,
                    "providerType": "openai",
                    "modelId": "model",
                    "enabled": true
                }),
            );
        }
        core.provider_registry.load(&providers);
        let keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&keys);
        core.quota_manager.register_providers(&keys);

        let routing = Map::from_iter([(
            "thinking".to_string(),
            Value::Array(vec![
                json!({
                    "id": "thinking-primary",
                    "priority": 200,
                    "mode": "priority",
                    "targets": ["primary.key1.model"]
                }),
                json!({
                    "id": "thinking-backup",
                    "priority": 100,
                    "mode": "priority",
                    "targets": ["backup.key1.model"]
                }),
            ]),
        )]);
        core.routing = parse_routing(&routing);

        let selected = core
            .select_provider(
                "thinking",
                &json!({ "excludedProviderKeys": ["primary.key1.model"] }),
                &ClassificationResult {
                    route_name: "thinking".to_string(),
                    confidence: 1.0,
                    reasoning: "thinking:user-input".to_string(),
                    candidates: vec!["thinking".to_string(), "default".to_string()],
                },
                &RoutingFeatures::default(),
                &RoutingInstructionState::default(),
                None,
                unsafe { Env::from_raw(std::ptr::null_mut()) },
            )
            .expect("excluded primary pool should fall to backup pool");

        assert_eq!(selected.provider_key, "backup.key1.model");
        assert_eq!(selected.pool_id.as_deref(), Some("thinking-backup"));
    }

    #[test]
    fn select_provider_falls_to_default_route_when_requested_route_is_exhausted() {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        for key in ["thinking.key1.model", "default.key1.model"] {
            providers.insert(
                key.to_string(),
                json!({
                    "providerKey": key,
                    "providerType": "openai",
                    "modelId": "model",
                    "enabled": true
                }),
            );
        }
        core.provider_registry.load(&providers);
        let keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&keys);
        core.quota_manager.register_providers(&keys);
        core.health_manager.cooldown_provider(
            "thinking.key1.model",
            Some("HTTP_502".to_string()),
            Some(30 * 60_000),
            now_ms(),
        );

        let routing = Map::from_iter([
            (
                "thinking".to_string(),
                Value::Array(vec![json!({
                    "id": "thinking-primary",
                    "priority": 200,
                    "mode": "priority",
                    "targets": ["thinking.key1.model"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![json!({
                    "id": "default-backstop",
                    "priority": 100,
                    "mode": "priority",
                    "targets": ["default.key1.model"]
                })]),
            ),
        ]);
        core.routing = parse_routing(&routing);

        let selected = core
            .select_provider(
                "thinking",
                &json!({}),
                &ClassificationResult {
                    route_name: "thinking".to_string(),
                    confidence: 1.0,
                    reasoning: "thinking:user-input".to_string(),
                    candidates: vec!["thinking".to_string(), "default".to_string()],
                },
                &RoutingFeatures::default(),
                &RoutingInstructionState::default(),
                None,
                unsafe { Env::from_raw(std::ptr::null_mut()) },
            )
            .expect("default route should be selected when requested route is exhausted");

        assert_eq!(selected.provider_key, "default.key1.model");
        assert_eq!(selected.route_used, "default");
        assert_eq!(selected.pool_id.as_deref(), Some("default-backstop"));
    }

    // ============================================================
    // T4: Pool isolation by routePolicyGroup — based on real config.toml
    // ============================================================

    /// Simulate the real config.toml routing structure:
    /// - coding group: thinking→deepseek, coding→deepseek, tools→mini27+deepseek
    /// - default group: default→priority(mini27→dbittai→mimo), tools→priority(mini27→dbittai→mimo)
    /// Both groups define a "default" route with completely different targets.
    /// Pool isolation means group="coding" can NOT see default group's pools.
    #[test]
    fn pool_isolation_by_route_policy_group() {
        // Build pools that mimic real config.toml structure
        let coding_pools = vec![
            RoutePoolTier {
                id: "coding-thinking-deepseek".to_string(),
                targets: vec!["deepseek.key1.v4-flash".to_string()],
                priority: 200,
                mode: Some("weighted".to_string()),
                backup: None,
                force: None,
                load_balancing: None,
                route_params: Some(
                    serde_json::from_value(json!({
                        "routePolicyGroup": "coding"
                    }))
                    .unwrap(),
                ),
                thinking: None,
            },
            RoutePoolTier {
                id: "coding-default-deepseek".to_string(),
                targets: vec!["deepseek.key1.v4-flash".to_string()],
                priority: 200,
                mode: None,
                backup: None,
                force: None,
                load_balancing: None,
                route_params: Some(
                    serde_json::from_value(json!({
                        "routePolicyGroup": "coding"
                    }))
                    .unwrap(),
                ),
                thinking: None,
            },
        ];

        let default_pools = vec![RoutePoolTier {
            id: "default-priority-mini27".to_string(),
            targets: vec![
                "mini27.key1.MiniMax-M2.7".to_string(),
                "mimo.key1.mimo-v2.5-pro".to_string(),
            ],
            priority: 200,
            mode: Some("priority".to_string()),
            backup: None,
            force: None,
            load_balancing: None,
            route_params: Some(
                serde_json::from_value(json!({
                    "routePolicyGroup": "default"
                }))
                .unwrap(),
            ),
            thinking: None,
        }];

        // T4a: pool_matches_route_policy_group correctly filters
        for pool in &coding_pools {
            assert!(
                pool_matches_route_policy_group(pool, Some("coding")),
                "coding pool must match group=coding"
            );
            assert!(
                !pool_matches_route_policy_group(pool, Some("default")),
                "coding pool must NOT match group=default"
            );
        }
        for pool in &default_pools {
            assert!(
                pool_matches_route_policy_group(pool, Some("default")),
                "default pool must match group=default"
            );
            assert!(
                !pool_matches_route_policy_group(pool, Some("coding")),
                "default pool must NOT match group=coding"
            );
        }

        // T4b: resolve_route_pools_for_selection with group prefix
        let mut all_pools = std::collections::HashMap::new();
        all_pools.insert(
            "coding:thinking".to_string(),
            vec![RoutePoolTier {
                id: "coding-thinking-deepseek".to_string(),
                targets: vec!["deepseek.key1.v4-flash".to_string()],
                priority: 200,
                mode: None,
                backup: None,
                force: None,
                load_balancing: None,
                route_params: Some(
                    serde_json::from_value(json!({"routePolicyGroup": "coding"})).unwrap(),
                ),
                thinking: None,
            }],
        );
        all_pools.insert("coding:default".to_string(), coding_pools.clone());
        all_pools.insert("default:default".to_string(), default_pools.clone());

        let routing = crate::virtual_router_engine::routing::RoutingPools { pools: all_pools };

        // Request group=coding: should see coding:default pools
        let result =
            resolve_route_pools_for_selection(&routing, "default", Some(&"coding:".to_string()));
        assert_eq!(
            result.len(),
            2,
            "coding group should see 2 pools for route 'default'"
        );

        // Request group=default: should see default:default pools
        let result =
            resolve_route_pools_for_selection(&routing, "default", Some(&"default:".to_string()));
        assert_eq!(
            result.len(),
            1,
            "default group should see 1 pool for route 'default'"
        );
        assert_eq!(result[0].id, "default-priority-mini27");

        // Request group=coding with route=thinking: should see coding:thinking
        let result =
            resolve_route_pools_for_selection(&routing, "thinking", Some(&"coding:".to_string()));
        assert_eq!(
            result.len(),
            1,
            "coding group should see 1 pool for route 'thinking'"
        );
        assert_eq!(result[0].id, "coding-thinking-deepseek");
    }

    /// T4c: Un tagged pools must NOT leak into a port-scoped group.
    /// When a port requests group="coding", untagged/global pools must be invisible.
    #[test]
    fn pool_isolation_untagged_pools_not_leaked() {
        let untagged_pool = RoutePoolTier {
            id: "global-fallback".to_string(),
            targets: vec!["openai.key1.gpt-4o".to_string()],
            priority: 999,
            mode: None,
            backup: None,
            force: None,
            load_balancing: None,
            route_params: None, // No routePolicyGroup = untagged
            thinking: None,
        };

        // When no group is requested, untagged pool IS visible
        assert!(
            pool_matches_route_policy_group(&untagged_pool, None),
            "untagged pool should be visible when no group requested"
        );

        // When group=coding is requested, untagged pool is NOT visible
        assert!(
            !pool_matches_route_policy_group(&untagged_pool, Some("coding")),
            "untagged pool must NOT leak into port-scoped group"
        );

        // When group=default is requested, untagged pool is NOT visible
        assert!(
            !pool_matches_route_policy_group(&untagged_pool, Some("default")),
            "untagged pool must NOT leak into port-scoped group"
        );
    }

    #[test]
    fn startup_import_allows_persisted_cooldown_provider_through_selection() {
        // RED: After startup import with allow_persisted_reprobe=true,
        // a persisted 503 cooldown provider should be selectable via select_provider
        // even when there are multiple candidates in a priority pool.
        use crate::virtual_router_engine::routing_state_store::with_session_dir_override;
        use std::fs;
        use std::path::PathBuf;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rcc-startup-health-red-{unique}"));
        fs::create_dir_all(&temp_dir).unwrap();

        with_session_dir_override(temp_dir.to_str(), || {
            let provider_key = "sdfv.key1.gpt-5.5";
            let backup_key = "cc.key1.gpt-5.5";
            let mut core = VirtualRouterEngineCore::new();
            let mut providers = Map::new();
            for (key, model) in &[(provider_key, "gpt-5.5"), (backup_key, "gpt-5.5")] {
                providers.insert(
                    key.to_string(),
                    json!({
                        "providerKey": key,
                        "providerType": "responses",
                        "modelId": model,
                        "enabled": true
                    }),
                );
            }
            core.provider_registry.load(&providers);
            let keys = core.provider_registry.list_keys();
            core.health_manager.register_providers(&keys);
            core.quota_manager.register_providers(&keys);

            // Simulate persisted 503 cooldown in file
            let health_state = json!({
                "version": 1,
                "providerCooldowns": [{
                    "providerKey": "sdfv.1.gpt-5.5",
                    "reason": "__http_503_daily_cooldown__",
                    "cooldownExpiresAt": now_ms() + 86_400_000
                }]
            });
            let health_path = temp_dir.join("provider-health.json");
            fs::write(&health_path, serde_json::to_string(&health_state).unwrap()).unwrap();

            // Startup import
            core.refresh_provider_health_from_store(true);

            // Setup routing: priority [primary, backup]
            let routing = Map::from_iter([(
                "thinking".to_string(),
                Value::Array(vec![json!({
                    "id": "test-thinking",
                    "priority": 100,
                    "mode": "priority",
                    "targets": [provider_key, backup_key]
                })]),
            )]);
            core.routing = parse_routing(&routing);

            let classification = ClassificationResult {
                route_name: "thinking".to_string(),
                confidence: 1.0,
                reasoning: "test".to_string(),
                candidates: vec!["thinking".to_string()],
            };
            let features = RoutingFeatures::default();
            let routing_state = RoutingInstructionState::default();

            // RED: select_provider should pick the persisted cooldown provider
            // because persisted_503_reprobe_available = true after startup import
            let selected = core
                .select_provider(
                    "thinking",
                    &json!({}),
                    &classification,
                    &features,
                    &routing_state,
                    None,
                    unsafe { Env::from_raw(std::ptr::null_mut()) },
                )
                .expect("selection should succeed");
            assert_eq!(
                selected.provider_key, provider_key,
                "persisted cooldown provider should be allowed on startup first request"
            );
        });

        let _ = fs::remove_dir_all(PathBuf::from(temp_dir));
    }
}
