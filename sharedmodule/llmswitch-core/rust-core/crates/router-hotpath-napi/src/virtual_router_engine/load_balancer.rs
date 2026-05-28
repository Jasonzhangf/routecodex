use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use super::context_weighted::ContextWeightedConfig;
use super::health_weighted::HealthWeightedConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadBalancingPolicy {
    pub strategy: Option<String>,
    pub weights: Option<HashMap<String, i64>>,
    pub health_weighted: Option<HealthWeightedConfig>,
    pub context_weighted: Option<ContextWeightedConfig>,
}

impl Default for LoadBalancingPolicy {
    fn default() -> Self {
        Self {
            strategy: Some("round-robin".to_string()),
            weights: None,
            health_weighted: None,
            context_weighted: None,
        }
    }
}

#[derive(Debug, Default, Clone)]
struct RouteState {
    pointer: usize,
    weighted_current: HashMap<String, i64>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct RouteLoadBalancer {
    policy: LoadBalancingPolicy,
    states: HashMap<String, RouteState>,
}

impl RouteLoadBalancer {
    pub(crate) fn new(policy: Option<LoadBalancingPolicy>) -> Self {
        Self {
            policy: policy.unwrap_or(LoadBalancingPolicy {
                strategy: Some("round-robin".to_string()),
                weights: None,
                health_weighted: None,
                context_weighted: None,
            }),
            states: HashMap::new(),
        }
    }

    pub(crate) fn update_policy(&mut self, policy: Option<LoadBalancingPolicy>) {
        if let Some(policy) = policy {
            self.policy = policy;
        }
    }

    pub(crate) fn policy(&self) -> &LoadBalancingPolicy {
        &self.policy
    }

    pub(crate) fn select(
        &mut self,
        route_name: &str,
        candidates: &[String],
        _sticky_key: Option<&str>,
        weights: Option<&HashMap<String, i64>>,
        availability_check: impl Fn(&str) -> bool,
        strategy_override: Option<&str>,
    ) -> Option<String> {
        let available: Vec<String> = candidates
            .iter()
            .filter(|candidate| availability_check(candidate.as_str()))
            .cloned()
            .collect();
        if available.is_empty() {
            return None;
        }

        let strategy = strategy_override
            .or_else(|| self.policy.strategy.as_deref())
            .unwrap_or("round-robin");
        let default_weights = self.policy.weights.clone();
        let resolved_weights = weights.or(default_weights.as_ref());
        match strategy {
            "weighted" => Some(self.select_weighted(route_name, &available, resolved_weights)),
            _ => {
                if let Some(custom_weights) = weights {
                    let mut distinct: HashSet<i64> = HashSet::new();
                    for candidate in &available {
                        let weight = custom_weights.get(candidate).cloned().unwrap_or(1).max(1);
                        distinct.insert(weight);
                    }
                    if distinct.len() > 1 {
                        return Some(self.select_weighted(
                            route_name,
                            &available,
                            Some(custom_weights),
                        ));
                    }
                }
                Some(self.select_round_robin(route_name, &available))
            }
        }
    }

    pub(crate) fn select_round_robin_with_skips(
        &mut self,
        route_name: &str,
        candidates: &[String],
        availability_check: impl Fn(&str) -> bool,
    ) -> Option<String> {
        if candidates.is_empty() {
            return None;
        }
        let state = self.get_state_mut(route_name);
        let total = candidates.len();
        for offset in 0..total {
            let idx = (state.pointer + offset) % total;
            let candidate = candidates.get(idx)?;
            if !availability_check(candidate) {
                continue;
            }
            state.pointer = (idx + 1) % total;
            return Some(candidate.clone());
        }
        None
    }

    pub(crate) fn peek_round_robin_with_skips(
        &mut self,
        route_name: &str,
        candidates: &[String],
        availability_check: impl Fn(&str) -> bool,
    ) -> Option<String> {
        if candidates.is_empty() {
            return None;
        }
        let state = self.get_state_mut(route_name);
        let total = candidates.len();
        for offset in 0..total {
            let idx = (state.pointer + offset) % total;
            let candidate = candidates.get(idx)?;
            if availability_check(candidate) {
                return Some(candidate.clone());
            }
        }
        None
    }

    pub(crate) fn select_grouped(
        &mut self,
        route_name: &str,
        ordered_group_ids: &[String],
        groups: &HashMap<String, Vec<String>>,
        _sticky_key: Option<&str>,
        weights: Option<&HashMap<String, i64>>,
        availability_check: impl Fn(&str) -> bool,
        strategy_override: Option<&str>,
    ) -> Option<String> {
        let available_groups: Vec<String> = ordered_group_ids
            .iter()
            .filter(|group_id| {
                groups
                    .get(*group_id)
                    .map(|members| {
                        members
                            .iter()
                            .any(|candidate| availability_check(candidate.as_str()))
                    })
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if available_groups.is_empty() {
            return None;
        }

        let strategy = strategy_override
            .or_else(|| self.policy.strategy.as_deref())
            .unwrap_or("round-robin");
        let group_route = format!("{}:group", route_name);
        let selected_group = match strategy {
            "weighted" => self.select_weighted(&group_route, &available_groups, weights),
            _ => self.select_round_robin(&group_route, &available_groups),
        };

        let group_candidates: Vec<String> = groups
            .get(&selected_group)?
            .iter()
            .filter(|candidate| availability_check(candidate.as_str()))
            .cloned()
            .collect();
        if group_candidates.is_empty() {
            return None;
        }

        Some(self.select_round_robin(
            &format!("{}:{}", group_route, selected_group),
            &group_candidates,
        ))
    }

    pub(crate) fn select_round_robin_for_route(
        &mut self,
        route_name: &str,
        candidates: &[String],
    ) -> Option<String> {
        if candidates.is_empty() {
            return None;
        }
        Some(self.select_round_robin(route_name, candidates))
    }

    fn select_round_robin(&mut self, route_name: &str, candidates: &[String]) -> String {
        let state = self.get_state_mut(route_name);
        let idx = state.pointer % candidates.len();
        let choice = candidates[idx].clone();
        state.pointer = (state.pointer + 1) % candidates.len();
        choice
    }

    fn select_weighted(
        &mut self,
        route_name: &str,
        candidates: &[String],
        weights: Option<&HashMap<String, i64>>,
    ) -> String {
        let state = self.get_state_mut(route_name);
        let current = &mut state.weighted_current;
        let candidate_set: HashSet<String> = candidates.iter().cloned().collect();
        current.retain(|key, _| candidate_set.contains(key));
        for key in candidates {
            current.entry(key.clone()).or_insert(0);
        }

        let candidate_weights: Vec<i64> = candidates
            .iter()
            .map(|candidate| {
                weights
                    .and_then(|w| w.get(candidate))
                    .cloned()
                    .unwrap_or(1)
                    .max(1)
            })
            .collect();
        let total_weight: i64 = candidate_weights.iter().sum();

        let mut best_index = 0usize;
        let mut best_score: i64 = i64::MIN;
        for (idx, candidate) in candidates.iter().enumerate() {
            let weight = candidate_weights[idx];
            let next = current.get(candidate).cloned().unwrap_or(0) + weight;
            current.insert(candidate.clone(), next);
            if next > best_score {
                best_score = next;
                best_index = idx;
            }
        }
        let selected_key = candidates[best_index].clone();
        let current_value = current.get(&selected_key).cloned().unwrap_or(0) - total_weight;
        current.insert(selected_key.clone(), current_value);
        selected_key
    }

    fn get_state_mut(&mut self, route_name: &str) -> &mut RouteState {
        self.states
            .entry(route_name.to_string())
            .or_insert_with(RouteState::default)
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn sticky_strategy_is_treated_as_round_robin_for_non_continuation_requests() {
        let mut lb = RouteLoadBalancer::new(Some(LoadBalancingPolicy {
            strategy: Some("sticky".to_string()),
            weights: None,
            health_weighted: None,
            context_weighted: None,
        }));
        let candidates = vec!["provider-a".to_string(), "provider-b".to_string()];

        let first = lb
            .select("thinking", &candidates, Some("session:same"), None, |_| true, None)
            .expect("first selection");
        let second = lb
            .select("thinking", &candidates, Some("session:same"), None, |_| true, None)
            .expect("second selection");

        assert_eq!(first, "provider-a");
        assert_eq!(second, "provider-b", "non-continuation requests must not be pinned by sticky load balancing");
    }

    #[test]
    fn round_robin_covers_all_aliases_in_single_model_pool() {
        let mut lb = RouteLoadBalancer::new(None);
        let candidates = (1..=5)
            .map(|idx| format!("windsurf.ws-pro-{idx}.gpt-5.4-none"))
            .collect::<Vec<_>>();
        let mut hits = Vec::new();
        for _ in 0..5 {
            hits.push(
                lb.select_round_robin_for_route("thinking", &candidates)
                    .expect("candidate should be selected"),
            );
        }
        assert_eq!(hits, candidates);
    }
}
