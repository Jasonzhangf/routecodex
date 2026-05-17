use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

use super::super::features::RoutingFeatures;
use super::super::load_balancer::LoadBalancingPolicy;
use super::super::provider_registry::ProviderRegistry;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutePoolTier {
    pub id: String,
    pub targets: Vec<String>,
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_balancing: Option<LoadBalancingPolicy>,
    #[serde(rename = "routeParams", skip_serializing_if = "Option::is_none")]
    pub route_params: Option<Map<String, Value>>,
    /// Reasoning effort override for this route pool (low/medium/high/off).
    /// When None, falls back to route-level default logic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RoutingPools {
    pub pools: HashMap<String, Vec<RoutePoolTier>>,
}

impl RoutingPools {
    pub(crate) fn get(&self, route: &str) -> Vec<RoutePoolTier> {
        self.pools.get(route).cloned().unwrap_or_default()
    }

    pub(crate) fn has_targets(&self, pools: &[RoutePoolTier]) -> bool {
        pools.iter().any(|tier| !tier.targets.is_empty())
    }

    pub(crate) fn flatten_targets(&self, pools: &[RoutePoolTier]) -> Vec<String> {
        let mut out = Vec::new();
        for tier in pools {
            for target in &tier.targets {
                if !out.contains(target) {
                    out.push(target.clone());
                }
            }
        }
        out
    }
}

pub(crate) fn parse_routing(routing: &Map<String, Value>) -> RoutingPools {
    let mut pools = HashMap::new();
    for (route, value) in routing.iter() {
        let tiers = value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value::<RoutePoolTier>(item.clone()).ok())
                    .collect::<Vec<RoutePoolTier>>()
            })
            .unwrap_or_default();
        pools.insert(route.clone(), tiers);
    }
    RoutingPools { pools }
}

pub(crate) fn route_has_targets(routing: &RoutingPools, route: &str) -> bool {
    let pools = routing.get(route);
    pools.iter().any(|tier| !tier.targets.is_empty())
}

pub(crate) fn build_route_queue(
    requested_route: &str,
    candidates: &[String],
    features: &RoutingFeatures,
    routing: &RoutingPools,
) -> Vec<String> {
    let mut queue: Vec<String> = Vec::new();
    let protects_default_fallback = protects_default_fallback(requested_route, routing);
    let has_multimodal_targets = route_has_targets(routing, "multimodal");
    let has_vision_targets = route_has_targets(routing, "vision");
    let has_video_targets = route_has_targets(routing, "video");
    let has_remote_video_attachment =
        features.has_video_attachment && features.has_remote_video_attachment;

    if !requested_route.trim().is_empty() {
        queue.push(requested_route.to_string());
    }
    for route in candidates {
        if protects_default_fallback && route == super::super::classifier::DEFAULT_ROUTE {
            continue;
        }
        if !queue.contains(route) {
            queue.push(route.clone());
        }
    }

    if has_remote_video_attachment && has_video_targets && !queue.iter().any(|v| v == "video") {
        queue.insert(0, "video".to_string());
    }

    if features.has_image_attachment {
        if has_multimodal_targets {
            if !queue.iter().any(|v| v == "multimodal") {
                queue.insert(0, "multimodal".to_string());
            }
        } else if has_vision_targets && !queue.iter().any(|v| v == "vision") {
            queue.insert(0, "vision".to_string());
        }
    }

    let mut deduped: Vec<String> = Vec::new();
    for route in queue {
        if !route.trim().is_empty() && !deduped.contains(&route) {
            deduped.push(route);
        }
    }
    if !protects_default_fallback
        && !deduped.contains(&super::super::classifier::DEFAULT_ROUTE.to_string())
    {
        deduped.push(super::super::classifier::DEFAULT_ROUTE.to_string());
    }
    deduped
}

fn protects_default_fallback(requested_route: &str, routing: &RoutingPools) -> bool {
    matches!(
        requested_route.trim(),
        "thinking" | "coding" | "search" | "longcontext"
    ) && route_has_targets(routing, requested_route)
}

pub(crate) fn build_route_candidates(
    requested_route: &str,
    candidates: &[String],
    features: &RoutingFeatures,
    routing: &RoutingPools,
) -> Vec<String> {
    let mut route_queue: Vec<String> = Vec::new();
    route_queue.push(requested_route.to_string());
    for route in candidates {
        if !route_queue.contains(route) {
            route_queue.push(route.clone());
        }
    }
    if !route_queue.contains(&super::super::classifier::DEFAULT_ROUTE.to_string()) {
        route_queue.push(super::super::classifier::DEFAULT_ROUTE.to_string());
    }
    let mut available: Vec<String> = Vec::new();
    for route in route_queue {
        let pools = routing.get(&route);
        for pool in pools {
            for key in &pool.targets {
                if !available.contains(key) {
                    available.push(key.clone());
                }
            }
        }
    }
    if features.has_image_attachment && requested_route == "multimodal" {
        let mut prioritized: Vec<String> = Vec::new();
        let mut others: Vec<String> = Vec::new();
        for key in &available {
            if key.contains("responses") || key.contains("gemini") {
                prioritized.push(key.clone());
            } else {
                others.push(key.clone());
            }
        }
        if !prioritized.is_empty() {
            prioritized.extend(others);
            return prioritized;
        }
    }
    available
}

pub(crate) fn filter_pools_by_capability(
    pools: &[RoutePoolTier],
    provider_registry: &ProviderRegistry,
    capability: &str,
) -> Vec<RoutePoolTier> {
    let mut out = Vec::new();
    for pool in pools {
        if pool.targets.is_empty() {
            continue;
        }
        let targets: Vec<String> = pool
            .targets
            .iter()
            .filter(|key| {
                if capability == "web_search" {
                    return provider_registry.has_capability(key, "web_search")
                        || provider_registry.has_capability(key, "web_search_direct");
                }
                provider_registry.has_capability(key, capability)
            })
            .cloned()
            .collect();
        if targets.is_empty() {
            continue;
        }
        let mut next = pool.clone();
        next.targets = targets;
        out.push(next);
    }
    out
}

pub(crate) fn default_pool_supports_capability(
    routing: &RoutingPools,
    provider_registry: &ProviderRegistry,
    capability: &str,
) -> bool {
    let pools = routing.get(super::super::classifier::DEFAULT_ROUTE);
    !filter_pools_by_capability(&pools, provider_registry, capability).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::features::RoutingFeatures;
    use serde_json::{Map, Value};

    #[test]
    fn declared_web_search_tool_does_not_prepend_web_search_route() {
        let routing = parse_routing(&Map::from_iter([(
            "web_search".to_string(),
            Value::Array(vec![serde_json::json!({
                "id": "web-search",
                "priority": 100,
                "targets": ["provider.search"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_web_search_tool_declared: true,
            ..Default::default()
        };

        let queue = build_route_queue("thinking", &["default".to_string()], &features, &routing);

        assert_eq!(queue, vec!["thinking".to_string(), "default".to_string()]);
    }

    #[test]
    fn explicit_web_search_route_is_preserved() {
        let routing = parse_routing(&Map::from_iter([(
            "web_search".to_string(),
            Value::Array(vec![serde_json::json!({
                "id": "web-search",
                "priority": 100,
                "targets": ["provider.search"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_web_search_tool_declared: true,
            ..Default::default()
        };

        let queue = build_route_queue("web_search", &["default".to_string()], &features, &routing);

        assert_eq!(queue, vec!["web_search".to_string(), "default".to_string()]);
    }

    #[test]
    fn thinking_route_with_targets_does_not_fall_back_to_default() {
        let routing = parse_routing(&Map::from_iter([
            (
                "thinking".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "thinking",
                    "priority": 100,
                    "targets": ["provider.thinking"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "default",
                    "priority": 100,
                    "targets": ["provider.default"]
                })]),
            ),
        ]));
        let queue = build_route_queue(
            "thinking",
            &["thinking".to_string(), "default".to_string()],
            &RoutingFeatures::default(),
            &routing,
        );
        assert_eq!(queue, vec!["thinking".to_string()]);
    }

    #[test]
    fn coding_route_without_targets_can_still_fall_back_to_default() {
        let routing = parse_routing(&Map::from_iter([(
            "default".to_string(),
            Value::Array(vec![serde_json::json!({
                "id": "default",
                "priority": 100,
                "targets": ["provider.default"]
            })]),
        )]));
        let queue = build_route_queue(
            "coding",
            &["default".to_string()],
            &RoutingFeatures::default(),
            &routing,
        );
        assert_eq!(queue, vec!["coding".to_string(), "default".to_string()]);
    }
}
