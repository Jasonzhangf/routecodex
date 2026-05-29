use std::collections::HashMap;

use crate::virtual_router_engine::load_balancer::LoadBalancingPolicy;
use crate::virtual_router_engine::routing::{extract_provider_id, RoutePoolTier};

#[derive(Debug, Clone)]
pub(crate) struct ResolvedTierLoadBalancing {
    pub strategy: String,
    pub weights: Option<HashMap<String, i64>>,
}

pub(crate) fn resolve_tier_load_balancing(
    tier: &RoutePoolTier,
    global_policy: &LoadBalancingPolicy,
) -> ResolvedTierLoadBalancing {
    let strategy = tier
        .load_balancing
        .as_ref()
        .and_then(|cfg| cfg.strategy.clone())
        .or_else(|| global_policy.strategy.clone())
        .unwrap_or_else(|| "round-robin".to_string());
    let weights = tier
        .load_balancing
        .as_ref()
        .and_then(|cfg| cfg.weights.clone())
        .or_else(|| global_policy.weights.clone());
    ResolvedTierLoadBalancing { strategy, weights }
}

pub(crate) fn build_group_weights(
    groups: &HashMap<String, Vec<String>>,
    weights: Option<&HashMap<String, i64>>,
) -> Option<HashMap<String, i64>> {
    let weights = match weights {
        Some(weights) => weights,
        None => return None,
    };
    let mut out = HashMap::new();
    let mut has_explicit = false;
    for group_id in groups.keys() {
        let weight = resolve_group_weight(group_id, Some(weights));
        if weight != 1 {
            has_explicit = true;
        }
        out.insert(group_id.clone(), weight);
    }
    if has_explicit {
        Some(out)
    } else {
        None
    }
}

fn resolve_group_weight(group_id: &str, weights: Option<&HashMap<String, i64>>) -> i64 {
    let weights = match weights {
        Some(weights) => weights,
        None => return 1,
    };
    if let Some(weight) = normalize_positive_weight(weights.get(group_id).cloned()) {
        return weight;
    }
    let provider_id = extract_provider_id(group_id).unwrap_or_else(|| group_id.to_string());
    normalize_positive_weight(weights.get(provider_id.as_str()).cloned()).unwrap_or(1)
}

fn normalize_positive_weight(value: Option<i64>) -> Option<i64> {
    value.filter(|weight| *weight > 0)
}
