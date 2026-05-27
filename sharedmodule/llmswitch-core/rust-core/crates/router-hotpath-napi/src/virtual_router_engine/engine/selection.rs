use napi::Env;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::virtual_router_engine::context_weighted::{
    compute_context_multiplier, compute_effective_safe_window_tokens,
    resolve_context_weighted_config,
};
use super::tier_load_balancing::{
    build_candidate_weights, build_group_weights, resolve_tier_load_balancing,
};
use super::types::SelectionResult;
use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::classifier::{ClassificationResult, DEFAULT_ROUTE};
use crate::virtual_router_engine::error::{
    format_virtual_router_error, format_virtual_router_error_with_details,
};
use crate::virtual_router_engine::features::RoutingFeatures;
use crate::virtual_router_engine::health_weighted::{
    compute_health_weight, resolve_health_weighted_config,
};
use crate::virtual_router_engine::instructions::RoutingInstructionState;
use crate::virtual_router_engine::quota::ProviderQuotaState;
use crate::virtual_router_engine::routing::{
    build_route_queue, default_pool_supports_capability, extract_excluded_provider_keys,
    extract_provider_id, extract_runtime_now_ms, filter_candidates_by_state,
    filter_pools_by_capability, resolve_instruction_target, route_has_targets,
    InstructionTargetMatchMode,
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
        None => true,
    }
}

fn order_instruction_keys_by_default_route(
    keys: &[String],
    routing: &crate::virtual_router_engine::routing::RoutingPools,
) -> Vec<String> {
    if keys.len() <= 1 {
        return keys.to_vec();
    }
    let key_set: HashSet<&str> = keys.iter().map(String::as_str).collect();
    let mut ordered: Vec<String> = Vec::new();
    for pool in routing.get(DEFAULT_ROUTE) {
        for target in pool.targets {
            if key_set.contains(target.as_str()) && !ordered.contains(&target) {
                ordered.push(target);
            }
        }
    }
    let mut remaining: Vec<String> = keys
        .iter()
        .filter(|key| !ordered.contains(*key))
        .cloned()
        .collect();
    remaining.sort();
    ordered.extend(remaining);
    ordered
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

fn build_context_weighted_map(
    provider_registry: &crate::virtual_router_engine::provider_registry::ProviderRegistry,
    candidates: &[String],
    warn_ratio: f64,
    raw_cfg: Option<&crate::virtual_router_engine::context_weighted::ContextWeightedConfig>,
) -> Option<HashMap<String, i64>> {
    let cfg = resolve_context_weighted_config(raw_cfg);
    if !cfg.enabled || candidates.len() <= 1 {
        return None;
    }

    let mut safe_windows: HashMap<String, i64> = HashMap::new();
    let mut reference_safe_tokens = cfg.client_cap_tokens.max(1);
    for key in candidates {
        let model_max_tokens = provider_registry
            .get(key)
            .and_then(|profile| profile.max_context_tokens)
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MODEL_CONTEXT_TOKENS);
        let effective_safe_tokens = compute_effective_safe_window_tokens(
            model_max_tokens,
            warn_ratio,
            cfg.client_cap_tokens,
        );
        if effective_safe_tokens > reference_safe_tokens {
            reference_safe_tokens = effective_safe_tokens;
        }
        safe_windows.insert(key.clone(), effective_safe_tokens);
    }

    let mut weights = HashMap::new();
    let mut has_non_uniform = false;
    for key in candidates {
        let effective_safe_tokens = *safe_windows.get(key).unwrap_or(&reference_safe_tokens);
        let multiplier =
            compute_context_multiplier(reference_safe_tokens, effective_safe_tokens, &cfg);
        let weight = (100.0 * multiplier).round().max(1.0) as i64;
        if weight != 100 {
            has_non_uniform = true;
        }
        weights.insert(key.clone(), weight);
    }

    if has_non_uniform { Some(weights) } else { None }
}

impl VirtualRouterEngineCore {
    /// Apply standard candidate filters: routing state, excluded keys, and provider availability.
    /// This is the single filter chain used by all selection paths (forced, sticky, prefer, pool).
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
            .into_iter()
            .filter(|key| !excluded_keys.contains(key))
            .collect();
        let mut available: Vec<String> = route_candidates
            .iter()
            .filter(|key| self.is_provider_available(env, key))
            .cloned()
            .collect();
        if available.is_empty() && route_candidates.len() == 1 {
            let provider_key = &route_candidates[0];
            if self.is_singleton_provider_soft_available_from_rust_quota(env, provider_key) {
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

        if let Some(target) = &routing_state.sticky_target {
            if let Some(resolved) = resolve_instruction_target(target, &self.provider_registry) {
                let ordered_keys =
                    order_instruction_keys_by_default_route(&resolved.keys, &self.routing);
                let available =
                    self.apply_standard_filters(env, &ordered_keys, routing_state, &excluded_keys);
                let available_set: HashSet<String> = available.iter().cloned().collect();
                let sticky_key = match resolved.mode {
                    InstructionTargetMatchMode::Exact => available.into_iter().next(),
                    InstructionTargetMatchMode::Filter => self
                        .load_balancer
                        .select_round_robin_with_skips("sticky", &ordered_keys, |key| {
                            available_set.contains(key)
                        }),
                };
                if let Some(sticky_key) = sticky_key {
                    return Ok(SelectionResult::new(
                        sticky_key.clone(),
                        requested_route.to_string(),
                        ordered_keys,
                        Some("sticky".to_string()),
                    ));
                }
            }
        }

        if let Some(target) = &routing_state.prefer_target {
            if let Some(resolved) = resolve_instruction_target(target, &self.provider_registry) {
                let ordered_keys =
                    order_instruction_keys_by_default_route(&resolved.keys, &self.routing);
                let available =
                    self.apply_standard_filters(env, &ordered_keys, routing_state, &excluded_keys);
                let available_set: HashSet<String> = available.iter().cloned().collect();
                let mutation_only = metadata
                    .get("routingInstructionMutationOnly")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let prefer_key = match resolved.mode {
                    InstructionTargetMatchMode::Exact => available.into_iter().next(),
                    InstructionTargetMatchMode::Filter => {
                        let route_key = format!("prefer:{}", ordered_keys.join("|"));
                        if mutation_only {
                            self.load_balancer.peek_round_robin_with_skips(
                                &route_key,
                                &ordered_keys,
                                |key| available_set.contains(key),
                            )
                        } else {
                            self.load_balancer.select_round_robin_with_skips(
                                &route_key,
                                &ordered_keys,
                                |key| available_set.contains(key),
                            )
                        }
                    }
                };
                if let Some(prefer_key) = prefer_key {
                    return Ok(SelectionResult::new(
                        prefer_key.clone(),
                        "prefer".to_string(),
                        ordered_keys,
                        Some("prefer".to_string()),
                    ));
                }
            }
        }

        let mut route_queue = build_route_queue(
            requested_route,
            &classification.candidates,
            features,
            &self.routing,
        );
        let sticky_key = crate::virtual_router_engine::routing::resolve_sticky_key(metadata);
        let now_for_weights = extract_runtime_now_ms(metadata).unwrap_or_else(now_ms);
        let health_cfg =
            resolve_health_weighted_config(self.load_balancer.policy().health_weighted.as_ref());
        let requested_route_policy_group = read_requested_route_policy_group(metadata);
        let requires_remote_video = features.has_video_attachment
            && features.has_remote_video_attachment
            && route_has_targets(&self.routing, "video");
        let web_search_route_requested = classification.route_name == "web_search";
        let multimodal_route_requested = features.has_image_attachment;
        let has_explicit_web_search_route = route_has_targets(&self.routing, "web_search");
        let default_pool_supports_web_search =
            default_pool_supports_capability(&self.routing, &self.provider_registry, "web_search");
        let default_pool_supports_multimodal =
            default_pool_supports_capability(&self.routing, &self.provider_registry, "multimodal");
        let use_default_pool_web_search_fallback =
            web_search_route_requested && default_pool_supports_web_search;
        let use_default_pool_multimodal_fallback =
            multimodal_route_requested;
        let longcontext_candidate_active = requested_route == "longcontext"
            || classification
                .candidates
                .iter()
                .any(|candidate| candidate == "longcontext");

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
                && use_default_pool_web_search_fallback
            {
                self.routing.get(DEFAULT_ROUTE)
            } else if multimodal_route_requested
                && route_name == DEFAULT_ROUTE
                && use_default_pool_multimodal_fallback
            {
                self.routing.get(DEFAULT_ROUTE)
            } else {
                self.routing.get(&route_name)
            };
            if web_search_route_requested
                && route_name == DEFAULT_ROUTE
                && use_default_pool_web_search_fallback
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
                } else if use_default_pool_multimodal_fallback && route_name == "multimodal" {
                    // Multimodal direct-routing may point to non-multimodal targets.
                    // When default pool contains multimodal-capable targets, skip this route
                    // and fall through to default-pool capability fallback instead.
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
                    } else if self.context_hard_limit {
                        continue;
                    } else if route_name != DEFAULT_ROUTE && !overflow_context.is_empty() {
                        continue;
                    } else if !overflow_context.is_empty() {
                        available = overflow_context;
                    }
                }
                if available.is_empty() {
                    continue;
                }
                let tier_load_balancing =
                    resolve_tier_load_balancing(&pool, self.load_balancer.policy());
                let mut dynamic_weight_map: Option<HashMap<String, i64>> = None;
                let context_weight_map = build_context_weighted_map(
                    &self.provider_registry,
                    &available,
                    self.context_warn_ratio,
                    self.load_balancer.policy().context_weighted.as_ref(),
                );
                if health_cfg.enabled {
                    let mut weights = HashMap::new();
                    for key in &available {
                        let entry = self.quota_manager.get_state(key);
                        let weight =
                            compute_health_weight(entry.as_ref(), now_for_weights, &health_cfg);
                        let context_weight =
                            context_weight_map.as_ref().and_then(|map| map.get(key)).cloned();
                        let final_weight = match context_weight {
                            Some(ctx) => ((weight as i128) * (ctx as i128) / 100).max(1) as i64,
                            None => weight,
                        };
                        weights.insert(key.clone(), final_weight);
                    }
                    if !excluded_keys.is_empty() && health_cfg.recover_to_best_on_retry {
                        let mut best_key: Option<String> = None;
                        let mut best_weight: i64 = i64::MIN;
                        for key in &available {
                            let weight = *weights.get(key).unwrap_or(&1);
                            if weight > best_weight {
                                best_weight = weight;
                                best_key = Some(key.clone());
                            }
                        }
                        if let Some(provider_key) = best_key {
                            return Ok(SelectionResult::new(
                                provider_key,
                                route_name.to_string(),
                                pool.targets.clone(),
                                Some(pool.id.clone()),
                            )
                            .with_route_params(pool.route_params.clone()));
                        }
                    }
                    dynamic_weight_map = Some(weights);
                } else {
                    let mut weights = HashMap::new();
                    let mut has_penalty = false;
                    for key in &available {
                        let mut final_weight = context_weight_map
                            .as_ref()
                            .and_then(|map| map.get(key))
                            .cloned()
                            .unwrap_or(100);
                        if let Some(state) = self.quota_manager.get_state(key) {
                            let penalty = state.consecutive_error_count.max(0) as f64;
                            let penalty_weight =
                                (100.0 / (1.0 + penalty)).floor().max(1.0) as i64;
                            final_weight =
                                ((final_weight as i128) * (penalty_weight as i128) / 100).max(1)
                                    as i64;
                            if penalty > 0.0 {
                                has_penalty = true;
                            }
                        }
                        weights.insert(key.clone(), final_weight);
                    }
                    if has_penalty || context_weight_map.is_some() {
                        dynamic_weight_map = Some(weights);
                    }
                }
                let weight_map = build_candidate_weights(
                    &available,
                    &self.provider_registry,
                    tier_load_balancing.weights.as_ref(),
                    dynamic_weight_map.as_ref(),
                );
                let sticky_for_lb = &sticky_key;
                // v2 weighted pools may be materialized by the bootstrap layer as:
                //   mode=priority + loadBalancing.strategy=weighted
                // when the user only declared loadBalancing.weights (no explicit targets/order).
                // In that conflicting state, Rust selection must honor the weighted strategy
                // instead of letting the synthetic priority mode lock the pool to the first
                // provider.model group forever.
                let effective_priority_mode = pool.mode.as_deref() == Some("priority")
                    && tier_load_balancing.strategy != "weighted";
                let mode_override = if effective_priority_mode {
                    Some("priority")
                } else if let Some(mode) = pool.mode.as_deref() {
                    if mode == "priority" {
                        Some(tier_load_balancing.strategy.as_str())
                    } else {
                        Some(mode)
                    }
                } else {
                    Some(tier_load_balancing.strategy.as_str())
                };
                let route_key_for_lb = route_name.to_string();
                let (ordered_group_ids, grouped_candidates) =
                    build_primary_target_groups(&available, &self.provider_registry);
                let has_runtime_key_level_weights =
                    has_runtime_key_level_weights(tier_load_balancing.weights.as_ref(), &available);
                let can_select_grouped = pool.mode.as_deref() != Some("sticky")
                    && tier_load_balancing.strategy != "sticky"
                    && dynamic_weight_map.is_none()
                    && !has_runtime_key_level_weights;
                let selected = if effective_priority_mode {
                    available.first().cloned()
                } else if can_select_grouped && !ordered_group_ids.is_empty() {
                    let group_weights = build_group_weights(
                        &grouped_candidates,
                        tier_load_balancing.weights.as_ref(),
                    );
                    self.load_balancer.select_grouped(
                        &route_key_for_lb,
                        &ordered_group_ids,
                        &grouped_candidates,
                        Some(sticky_for_lb),
                        group_weights.as_ref(),
                        |_| true,
                        mode_override,
                    )
                } else {
                    self.load_balancer.select(
                        &route_key_for_lb,
                        &available,
                        Some(sticky_for_lb),
                        weight_map.as_ref(),
                        |_| true,
                        mode_override,
                    )
                };
                if let Some(provider_key) = selected {
                    return Ok(SelectionResult::new(
                        provider_key,
                        route_name.to_string(),
                        pool.targets.clone(),
                        Some(pool.id.clone()),
                    )
                    .with_route_params(pool.route_params.clone()));
                }
            }
        }
        let mut candidate_keys = Vec::new();
        for route_name in build_route_queue(
            requested_route,
            &classification.candidates,
            features,
            &self.routing,
        ) {
            for pool in self.routing.get(&route_name) {
                if !pool_matches_route_policy_group(&pool, requested_route_policy_group.as_deref())
                {
                    continue;
                }
                for key in filter_candidates_by_state(
                    &pool.targets,
                    routing_state,
                    &self.provider_registry,
                ) {
                    if excluded_keys.contains(&key) {
                        continue;
                    }
                    if !candidate_keys.contains(&key) {
                        candidate_keys.push(key);
                    }
                }
            }
        }

        Err(build_provider_not_available_error(
            self,
            env,
            &candidate_keys,
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

fn has_runtime_key_level_weights(
    weights: Option<&HashMap<String, i64>>,
    candidates: &[String],
) -> bool {
    let Some(weights) = weights else {
        return false;
    };
    candidates.iter().any(|key| weights.contains_key(key))
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
    if let Some(existing) = blockers.iter_mut().find(|item| item.provider_key == provider_key) {
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

    if let Some(wait_ms) = core.health_manager.cooldown_remaining_ms(provider_key, now_ms) {
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
    if state.blacklist_until.map(|until| until > now_ms).unwrap_or(false) {
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
        let mut sorted_hints = hints;
        sorted_hints.sort_by_key(|item| item.wait_ms);
        let details = json!({
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
            "PROVIDER_NOT_AVAILABLE",
            message,
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
