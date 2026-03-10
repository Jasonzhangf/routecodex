use std::collections::HashMap;

use crate::virtual_router_engine::load_balancer::LoadBalancingPolicy;
use crate::virtual_router_engine::provider_registry::ProviderRegistry;
use crate::virtual_router_engine::routing::RoutePoolTier;

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

pub(crate) fn build_candidate_weights(
    candidates: &[String],
    provider_registry: &ProviderRegistry,
    static_weights: Option<&HashMap<String, i64>>,
    dynamic_weights: Option<&HashMap<String, i64>>,
) -> Option<HashMap<String, i64>> {
    if static_weights.is_none() && dynamic_weights.is_none() {
        return None;
    }

    let mut out = HashMap::new();
    let mut has_explicit = false;
    for key in candidates {
        let dynamic = dynamic_weights.and_then(|weights| weights.get(key).cloned());
        let static_weight = resolve_candidate_weight(key, static_weights, provider_registry);
        if let Some(weight) = multiply_positive_weights(dynamic, static_weight) {
            if weight != 1 {
                has_explicit = true;
            }
            out.insert(key.clone(), weight);
        }
    }

    if has_explicit {
        Some(out)
    } else {
        None
    }
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

pub(crate) fn has_non_uniform_weights(
    candidates: &[String],
    weights: Option<&HashMap<String, i64>>,
) -> bool {
    let weights = match weights {
        Some(weights) if candidates.len() >= 2 => weights,
        _ => return false,
    };
    let mut reference: Option<i64> = None;
    for key in candidates {
        let value = match weights.get(key) {
            Some(value) => *value,
            None => continue,
        };
        if let Some(current) = reference {
            if current != value {
                return true;
            }
        } else {
            reference = Some(value);
        }
    }
    false
}

fn resolve_candidate_weight(
    key: &str,
    weights: Option<&HashMap<String, i64>>,
    provider_registry: &ProviderRegistry,
) -> Option<i64> {
    let weights = weights?;
    if let Some(weight) = normalize_positive_weight(weights.get(key).cloned()) {
        return Some(weight);
    }
    let provider_id = key.split('.').next().unwrap_or("").trim();
    if provider_id.is_empty() {
        return None;
    }
    if let Some(model_id) = provider_registry
        .get(key)
        .and_then(|profile| profile.model_id.clone())
    {
        let grouped_key = format!("{}.{}", provider_id, model_id);
        if let Some(weight) = normalize_positive_weight(weights.get(&grouped_key).cloned()) {
            return Some(weight);
        }
    }
    normalize_positive_weight(weights.get(provider_id).cloned())
}

fn resolve_group_weight(group_id: &str, weights: Option<&HashMap<String, i64>>) -> i64 {
    let weights = match weights {
        Some(weights) => weights,
        None => return 1,
    };
    if let Some(weight) = normalize_positive_weight(weights.get(group_id).cloned()) {
        return weight;
    }
    let provider_id = group_id.split('.').next().unwrap_or(group_id);
    normalize_positive_weight(weights.get(provider_id).cloned()).unwrap_or(1)
}

fn normalize_positive_weight(value: Option<i64>) -> Option<i64> {
    value.filter(|weight| *weight > 0)
}

fn multiply_positive_weights(first: Option<i64>, second: Option<i64>) -> Option<i64> {
    match (
        normalize_positive_weight(first),
        normalize_positive_weight(second),
    ) {
        (Some(a), Some(b)) => Some((a * b).max(1)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}
