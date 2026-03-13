use napi::Env;
use serde_json::Value;
use std::collections::HashMap;

use super::tier_load_balancing::{
    build_candidate_weights, build_group_weights, has_non_uniform_weights,
    resolve_tier_load_balancing,
};
use super::types::SelectionResult;
use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::classifier::{ClassificationResult, DEFAULT_ROUTE};
use crate::virtual_router_engine::error::format_virtual_router_error;
use crate::virtual_router_engine::features::RoutingFeatures;
use crate::virtual_router_engine::health_weighted::{
    compute_health_weight, resolve_health_weighted_config,
};
use crate::virtual_router_engine::instructions::RoutingInstructionState;
use crate::virtual_router_engine::quota::{call_quota_view, QuotaViewEntry};
use crate::virtual_router_engine::routing::{
    build_antigravity_alias_key, build_route_queue, default_pool_supports_capability,
    extract_excluded_provider_keys, extract_runtime_now_ms, filter_candidates_by_state,
    filter_pools_by_capability, resolve_instruction_target,
    should_avoid_antigravity_after_repeated_error, should_bind_antigravity_session,
};
use crate::virtual_router_engine::time_utils::now_ms;

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
            if let Some(forced_key) = resolve_instruction_target(target, &self.provider_registry) {
                if !excluded_keys.contains(&forced_key)
                    && self.is_provider_available(env, &forced_key)
                {
                    return Ok(SelectionResult::new(
                        forced_key.clone(),
                        requested_route.to_string(),
                        vec![forced_key.clone()],
                        Some("forced".to_string()),
                    ));
                }
            }
        }

        if let Some(target) = &routing_state.sticky_target {
            if let Some(sticky_key) = resolve_instruction_target(target, &self.provider_registry) {
                if !excluded_keys.contains(&sticky_key)
                    && self.is_provider_available(env, &sticky_key)
                {
                    return Ok(SelectionResult::new(
                        sticky_key.clone(),
                        requested_route.to_string(),
                        vec![sticky_key.clone()],
                        Some("sticky".to_string()),
                    ));
                }
            }
        }

        if let Some(target) = &routing_state.prefer_target {
            if let Some(prefer_key) = resolve_instruction_target(target, &self.provider_registry) {
                if !excluded_keys.contains(&prefer_key)
                    && self.is_provider_available(env, &prefer_key)
                {
                    return Ok(SelectionResult::new(
                        prefer_key.clone(),
                        "prefer".to_string(),
                        vec![prefer_key.clone()],
                        Some("prefer".to_string()),
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
        let sticky_key = crate::virtual_router_engine::routing::resolve_sticky_key(metadata);
        let avoid_antigravity =
            !excluded_keys.is_empty() && should_avoid_antigravity_after_repeated_error(metadata);
        let now_for_weights = extract_runtime_now_ms(metadata).unwrap_or_else(now_ms);
        let health_cfg =
            resolve_health_weighted_config(self.load_balancer.policy().health_weighted.as_ref());
        let requires_vision = features.has_image_attachment
            && default_pool_supports_capability(&self.routing, &self.provider_registry, "vision");
        let requires_web_search = (self.web_search_force
            || features.has_web_search_tool_declared
            || features.has_web_tool
            || features
                .last_assistant_tool_category
                .as_deref()
                .map(|cat| cat.eq_ignore_ascii_case("websearch"))
                .unwrap_or(false)
            || classification.route_name == "web_search")
            && default_pool_supports_capability(
                &self.routing,
                &self.provider_registry,
                "web_search",
            );
        let capability_filter_active = requires_vision || requires_web_search;

        for route_name in route_queue {
            let mut pools = if capability_filter_active {
                self.routing.get(DEFAULT_ROUTE)
            } else {
                self.routing.get(&route_name)
            };
            if requires_vision {
                pools = filter_pools_by_capability(&pools, &self.provider_registry, "vision");
            }
            if requires_web_search {
                pools = filter_pools_by_capability(&pools, &self.provider_registry, "web_search");
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
                let strict_binding = self
                    .load_balancer
                    .policy()
                    .alias_selection
                    .as_ref()
                    .and_then(|selection| selection.antigravity_session_binding.as_deref())
                    .map(|mode| mode.trim().eq_ignore_ascii_case("strict"))
                    .unwrap_or(false);
                if strict_binding && should_bind_antigravity_session(metadata) {
                    if let Some(session_id) = metadata
                        .get("antigravitySessionId")
                        .and_then(|v| v.as_str())
                    {
                        let trimmed = session_id.trim();
                        if !trimmed.is_empty() {
                            let has_antigravity_gemini = available.iter().any(|key| {
                                build_antigravity_alias_key(key, &self.provider_registry).is_some()
                            });
                            if has_antigravity_gemini {
                                if let Some(pinned_alias) = crate::req_outbound_stage3_compat::gemini_cli::lookup_antigravity_pinned_alias_for_session_id(trimmed, true) {
                                    let pinned_trimmed = pinned_alias.trim();
                                    if !pinned_trimmed.is_empty() {
                                        let pinned_key = if pinned_trimmed.contains("::") {
                                            pinned_trimmed.to_string()
                                        } else {
                                            format!("{}::gemini", pinned_trimmed)
                                        };
                                        available = available
                                            .into_iter()
                                            .filter(|key| {
                                                if let Some(alias_key) =
                                                    build_antigravity_alias_key(key, &self.provider_registry)
                                                {
                                                    alias_key == pinned_key
                                                } else {
                                                    true
                                                }
                                            })
                                            .collect();
                                    }
                                }
                            }
                        }
                    }
                }
                if avoid_antigravity && available.len() > 1 {
                    let non_antigravity: Vec<String> = available
                        .iter()
                        .filter(|key| !key.starts_with("antigravity."))
                        .cloned()
                        .collect();
                    if !non_antigravity.is_empty() {
                        available = non_antigravity;
                    }
                }
                if available.is_empty() {
                    continue;
                }
                let mut antigravity_sticky_key: Option<String> = None;
                if pool.mode.as_deref() == Some("round-robin")
                    && available.iter().all(|key| key.starts_with("antigravity."))
                {
                    let model_id = available
                        .get(0)
                        .and_then(|key| {
                            self.provider_registry
                                .get(key)
                                .and_then(|profile| profile.model_id.clone())
                        })
                        .unwrap_or_else(|| "antigravity".to_string());
                    antigravity_sticky_key =
                        Some(format!("antigravity:{}:{}", route_name, model_id));
                }
                if antigravity_sticky_key.is_some() {
                    if let Some(primary) = pool.targets.iter().find(|key| available.contains(key)) {
                        return Ok(SelectionResult::new(
                            primary.clone(),
                            route_name.to_string(),
                            pool.targets.clone(),
                            Some(pool.id.clone()),
                        ));
                    }
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
                let sticky_for_lb = antigravity_sticky_key.as_deref().unwrap_or(&sticky_key);
                let mode_override = if antigravity_sticky_key.is_some() {
                    Some("sticky")
                } else if let Some(mode) = pool.mode.as_deref() {
                    Some(mode)
                } else {
                    Some(tier_load_balancing.strategy.as_str())
                };
                let route_key_for_lb = if antigravity_sticky_key.is_some() {
                    format!("{}:{}:antigravity", route_name, pool.id)
                } else {
                    route_name.to_string()
                };
                let (ordered_group_ids, grouped_candidates) =
                    build_primary_target_groups(&available, &self.provider_registry);
                let can_select_grouped = antigravity_sticky_key.is_none()
                    && pool.mode.as_deref() != Some("sticky")
                    && tier_load_balancing.strategy != "sticky"
                    && !has_non_uniform_weights(&available, weight_map.as_ref());
                let selected = if pool.mode.as_deref() == Some("priority") {
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
        Err(format_virtual_router_error(
            "PROVIDER_NOT_AVAILABLE",
            "No providers available",
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
