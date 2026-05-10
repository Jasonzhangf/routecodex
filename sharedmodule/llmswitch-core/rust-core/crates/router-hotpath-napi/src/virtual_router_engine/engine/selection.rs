use napi::Env;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

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
use crate::virtual_router_engine::quota::{call_quota_view, QuotaViewEntry};
use crate::virtual_router_engine::routing::{
    build_route_queue, default_pool_supports_capability,
    extract_excluded_provider_keys, extract_runtime_now_ms, filter_candidates_by_state,
    filter_pools_by_capability, resolve_instruction_target, route_has_targets,
    InstructionTargetMatchMode,
};
use crate::virtual_router_engine::time_utils::now_ms;

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

impl VirtualRouterEngineCore {
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
        let excluded_keys = extract_excluded_provider_keys(metadata);

        if let Some(target) = &routing_state.forced_target {
            if let Some(resolved) = resolve_instruction_target(target, &self.provider_registry) {
                let available: Vec<String> = filter_candidates_by_state(
                    &resolved.keys,
                    routing_state,
                    &self.provider_registry,
                )
                .into_iter()
                .filter(|key| !excluded_keys.contains(key))
                .filter(|key| self.is_provider_available(env, key))
                .collect();
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
                let available: Vec<String> = filter_candidates_by_state(
                    &ordered_keys,
                    routing_state,
                    &self.provider_registry,
                )
                .into_iter()
                .filter(|key| !excluded_keys.contains(key))
                .filter(|key| self.is_provider_available(env, key))
                .collect();
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
                let available: Vec<String> = filter_candidates_by_state(
                    &ordered_keys,
                    routing_state,
                    &self.provider_registry,
                )
                .into_iter()
                .filter(|key| !excluded_keys.contains(key))
                .filter(|key| self.is_provider_available(env, key))
                .collect();
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
        if !routing_state.allowed_providers.is_empty()
            && route_has_targets(&self.routing, DEFAULT_ROUTE)
        {
            route_queue = vec![DEFAULT_ROUTE.to_string()];
        }
        let sticky_key = crate::virtual_router_engine::routing::resolve_sticky_key(metadata);
        let now_for_weights = extract_runtime_now_ms(metadata).unwrap_or_else(now_ms);
        let health_cfg =
            resolve_health_weighted_config(self.load_balancer.policy().health_weighted.as_ref());
        let requires_remote_video = features.has_video_attachment
            && features.has_remote_video_attachment
            && route_has_targets(&self.routing, "video");
        let web_search_route_requested = classification.route_name == "web_search"
            || features.has_web_search_tool_declared;
        let multimodal_route_requested = features.has_image_attachment;
        let has_explicit_web_search_route = route_has_targets(&self.routing, "web_search");
        let default_pool_supports_web_search =
            default_pool_supports_capability(&self.routing, &self.provider_registry, "web_search");
        let default_pool_supports_multimodal =
            default_pool_supports_capability(&self.routing, &self.provider_registry, "multimodal");
        let use_default_pool_web_search_fallback =
            web_search_route_requested && default_pool_supports_web_search;
        let use_default_pool_multimodal_fallback =
            multimodal_route_requested && default_pool_supports_multimodal;

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
                && (route_name == "multimodal"
                    || route_name == "vision"
                    || route_name == DEFAULT_ROUTE)
            {
                let capability_filtered =
                    filter_pools_by_capability(&pools, &self.provider_registry, "multimodal");
                if !capability_filtered.is_empty() {
                    pools = capability_filtered;
                } else if use_default_pool_multimodal_fallback
                    && (route_name == "multimodal" || route_name == "vision")
                {
                    // Legacy multimodal/vision routes may point to non-multimodal targets.
                    // When default pool contains multimodal-capable targets, skip this route
                    // and fall through to default-pool capability fallback instead.
                    continue;
                }
            }
            for pool in pools {
                if pool.targets.is_empty() {
                    continue;
                }
                let filtered = filter_candidates_by_state(
                    &pool.targets,
                    routing_state,
                    &self.provider_registry,
                );
                let mut available: Vec<String> = filtered
                    .into_iter()
                    .filter(|key| self.is_provider_available(env, key))
                    .collect();
                if !excluded_keys.is_empty() {
                    available.retain(|key| !excluded_keys.contains(key));
                }
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
                if available.is_empty() {
                    continue;
                }
                let tier_load_balancing =
                    resolve_tier_load_balancing(&pool, self.load_balancer.policy());
                let mut dynamic_weight_map: Option<HashMap<String, i64>> = None;
                if let Some(ref quota_view) = self.quota_view {
                    if health_cfg.enabled {
                        let mut weights = HashMap::new();
                        for key in &available {
                            let entry = call_quota_view(env, quota_view, key);
                            let weight =
                                compute_health_weight(entry.as_ref(), now_for_weights, &health_cfg);
                            weights.insert(key.clone(), weight);
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
                                ));
                            }
                        }
                        dynamic_weight_map = Some(weights);
                    } else {
                        let mut weights = HashMap::new();
                        let mut has_penalty = false;
                        for key in &available {
                            let entry = call_quota_view(env, quota_view, key);
                            if let Some(QuotaViewEntry {
                                selection_penalty: Some(penalty),
                                ..
                            }) = entry
                            {
                                let penalty = penalty.max(0) as f64;
                                let weight = (100.0 / (1.0 + penalty)).floor().max(1.0) as i64;
                                weights.insert(key.clone(), weight);
                                if penalty > 0.0 {
                                    has_penalty = true;
                                }
                            }
                        }
                        if has_penalty {
                            dynamic_weight_map = Some(weights);
                        }
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
                    let route_key = format!("{}:{}:priority", route_name, pool.id);
                    let priority_candidates = ordered_group_ids
                        .first()
                        .and_then(|group_id| grouped_candidates.get(group_id))
                        .cloned()
                        .unwrap_or_else(|| available.clone());
                    self.load_balancer.select(
                        &route_key,
                        &priority_candidates,
                        Some(sticky_for_lb),
                        weight_map.as_ref(),
                        |_| true,
                        Some("round-robin"),
                    )
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
                    ));
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
        if let Some(profile) = self.provider_registry.get(provider_key) {
            if !profile.enabled {
                return false;
            }
        }
        let now = now_ms();
        if let Some(ref quota_view) = self.quota_view {
            if let Some(entry) = call_quota_view(env, quota_view, provider_key) {
                if entry.in_pool == Some(false) {
                    return false;
                }
                if let Some(cooldown) = entry.cooldown_until {
                    if cooldown > now {
                        return false;
                    }
                }
                if let Some(blacklist) = entry.blacklist_until {
                    if blacklist > now {
                        return false;
                    }
                }
            }
        }
        self.health_manager.is_available(provider_key, now)
    }

    pub(crate) fn alias_blocked_by_quota(&self, env: Env, alias_key: &str) -> bool {
        let quota_view = match self.quota_view {
            Some(ref view) => view,
            None => return false,
        };
        let base = match alias_base(alias_key) {
            Some(base) => base,
            None => return false,
        };
        let prefix = format!("{}.", base);
        let mut saw_any = false;
        let mut any_in_pool = false;
        for key in self.provider_registry.list_keys() {
            if !key.starts_with(&prefix) {
                continue;
            }
            saw_any = true;
            match call_quota_view(env, quota_view, &key) {
                Some(entry) => {
                    if entry.in_pool != Some(false) {
                        any_in_pool = true;
                    }
                }
                None => {
                    any_in_pool = true;
                }
            }
        }
        saw_any && !any_in_pool
    }
}

fn build_primary_target_groups(
    candidates: &[String],
    provider_registry: &crate::virtual_router_engine::provider_registry::ProviderRegistry,
) -> (Vec<String>, HashMap<String, Vec<String>>) {
    let mut ordered_group_ids = Vec::new();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();

    for key in candidates {
        let provider_id = key.split('.').next().unwrap_or("").trim();
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

fn alias_base(alias_key: &str) -> Option<String> {
    let trimmed = alias_key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = trimmed.split("::").next().unwrap_or(trimmed).trim();
    if base.is_empty() {
        return None;
    }
    Some(base.to_string())
}

#[derive(Debug, Clone)]
struct RecoverableCooldownHint {
    provider_key: String,
    wait_ms: i64,
    source: &'static str,
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

fn collect_recoverable_cooldown_for_key(
    core: &VirtualRouterEngineCore,
    env: Env,
    provider_key: &str,
    now_ms: i64,
    min_recoverable_cooldown_ms: &mut Option<i64>,
    hints: &mut Vec<RecoverableCooldownHint>,
) {
    if let Some(ref quota_view) = core.quota_view {
        if let Some(entry) = call_quota_view(env, quota_view, provider_key) {
            if let Some(blacklist_until) = entry.blacklist_until {
                if blacklist_until > now_ms {
                    return;
                }
            }
            if let Some(cooldown_until) = entry.cooldown_until {
                if cooldown_until > now_ms {
                    record_recoverable_cooldown(
                        provider_key,
                        cooldown_until - now_ms,
                        "quota.cooldown",
                        min_recoverable_cooldown_ms,
                        hints,
                    );
                }
            }
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
    }
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

    for provider_key in candidate_keys {
        collect_recoverable_cooldown_for_key(
            core,
            env,
            provider_key,
            now_ms,
            &mut min_recoverable_cooldown_ms,
            &mut hints,
        );
    }

    if let Some(min_wait_ms) = min_recoverable_cooldown_ms {
        let mut sorted_hints = hints;
        sorted_hints.sort_by_key(|item| item.wait_ms);
        let details = json!({
            "minRecoverableCooldownMs": min_wait_ms,
            "recoverableCooldownHints": sorted_hints
                .into_iter()
                .take(8)
                .map(|item| json!({
                    "providerKey": item.provider_key,
                    "waitMs": item.wait_ms,
                    "source": item.source,
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
