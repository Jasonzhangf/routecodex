// feature_id: vr.route_availability_floor
//! Rust-owned ErrorErr05 route availability decision contract.
//!
//! TS executor/direct code may pass routing/config facts through this contract,
//! but must not locally decide default-pool availability, remaining route
//! candidates, route-pool authority, or last-provider truth.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::utils::{normalize_unique_trimmed_strings, trim_nonempty_str};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr05RouteAvailabilityDecisionInput {
    #[serde(default)]
    pub route_name: Option<String>,
    #[serde(default)]
    pub route_pool: Vec<String>,
    #[serde(default)]
    pub route_tiers: Vec<ErrorErr05RouteTierInput>,
    #[serde(default)]
    pub default_route_tiers: Vec<ErrorErr05RouteTierInput>,
    #[serde(default)]
    pub excluded_provider_keys: Vec<String>,
    #[serde(default)]
    pub provider_key: Option<String>,
    #[serde(default)]
    pub routing_decision_route_pool_present: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr05RouteTierInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub backup: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr05RouteAvailabilityDecision {
    pub route_pool_remaining_after_exclusion: Vec<String>,
    pub remaining_route_candidates: usize,
    pub default_pool_available: bool,
    pub policy_exhausted: bool,
    pub may_project: bool,
    pub route_pool_authoritative: bool,
    pub verified_last_provider: bool,
    pub has_alternative_candidate: bool,
    pub reason_code: String,
}

pub fn resolve_error_err05_route_availability_decision(
    input: &ErrorErr05RouteAvailabilityDecisionInput,
) -> ErrorErr05RouteAvailabilityDecision {
    let route_pool = normalize_unique_trimmed_strings(input.route_pool.iter().map(String::as_str));
    let excluded: HashSet<String> =
        normalize_unique_trimmed_strings(input.excluded_provider_keys.iter().map(String::as_str))
            .into_iter()
            .collect();
    let provider_key = input
        .provider_key
        .as_ref()
        .and_then(|value| trim_nonempty_str(value));
    let default_pool_available = resolve_default_pool_available(input, &route_pool, &excluded);
    let remaining: Vec<String> = route_pool
        .iter()
        .filter(|candidate| !excluded.contains(*candidate))
        .cloned()
        .collect();
    let has_alternative_candidate = provider_key.as_ref().is_some_and(|provider| {
        route_pool
            .iter()
            .any(|candidate| candidate != provider && !excluded.contains(candidate))
    });
    let configured_candidates = configured_route_candidates(&input.route_tiers);
    let route_pool_authoritative = input.routing_decision_route_pool_present
        && (route_pool.len() > 1
            || (route_pool.len() == 1
                && configured_candidates.len() == 1
                && !default_pool_available
                && excluded.is_empty()));
    let verified_last_provider = provider_key.as_ref().is_some_and(|provider| {
        route_pool.len() == 1
            && route_pool.first() == Some(provider)
            && configured_candidates.len() == 1
            && configured_candidates.contains(provider)
            && !default_pool_available
    });
    let policy_exhausted = remaining.is_empty() && !default_pool_available;
    let reason_code = if default_pool_available {
        "default_pool_available"
    } else if remaining.is_empty() {
        "route_pool_and_default_empty"
    } else if has_alternative_candidate {
        "route_pool_alternative_available"
    } else if verified_last_provider {
        "verified_last_provider"
    } else {
        "route_pool_remaining"
    };

    ErrorErr05RouteAvailabilityDecision {
        remaining_route_candidates: remaining.len(),
        route_pool_remaining_after_exclusion: remaining,
        default_pool_available,
        policy_exhausted,
        may_project: policy_exhausted,
        route_pool_authoritative,
        verified_last_provider,
        has_alternative_candidate,
        reason_code: reason_code.to_string(),
    }
}

fn resolve_default_pool_available(
    input: &ErrorErr05RouteAvailabilityDecisionInput,
    route_pool: &[String],
    excluded: &HashSet<String>,
) -> bool {
    let route_name = input
        .route_name
        .as_ref()
        .and_then(|value| trim_nonempty_str(value))
        .map(|value| value.to_ascii_lowercase());
    let mut tiers = input.route_tiers.clone();
    if route_name
        .as_deref()
        .is_some_and(|route| route != "default")
        && !input.default_route_tiers.is_empty()
    {
        tiers.extend(input.default_route_tiers.iter().cloned().map(|mut tier| {
            tier.backup = Some(true);
            tier
        }));
    }
    let route_pool_set: HashSet<&str> = route_pool.iter().map(|value| value.as_str()).collect();
    let Some(default_tier) = tiers.iter().find(|tier| tier.backup.unwrap_or(false)) else {
        return false;
    };
    default_tier.targets.iter().any(|target| {
        let Some(normalized) = trim_nonempty_str(target) else {
            return false;
        };
        !excluded.contains(&normalized) && !route_pool_set.contains(normalized.as_str())
    })
}

fn configured_route_candidates(tiers: &[ErrorErr05RouteTierInput]) -> HashSet<String> {
    let mut out = HashSet::new();
    for tier in tiers {
        for target in &tier.targets {
            if let Some(normalized) = trim_nonempty_str(target) {
                out.insert(normalized);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tier(targets: &[&str], backup: bool) -> ErrorErr05RouteTierInput {
        ErrorErr05RouteTierInput {
            id: None,
            targets: targets.iter().map(|value| value.to_string()).collect(),
            priority: None,
            backup: Some(backup),
        }
    }

    #[test]
    fn ordinary_route_exhausted_but_default_pool_available_is_non_terminal() {
        let decision = resolve_error_err05_route_availability_decision(
            &ErrorErr05RouteAvailabilityDecisionInput {
                route_name: Some("search".to_string()),
                route_pool: vec!["primary".to_string()],
                route_tiers: vec![tier(&["primary"], false)],
                default_route_tiers: vec![tier(&["default-a"], true)],
                excluded_provider_keys: vec!["primary".to_string()],
                provider_key: Some("primary".to_string()),
                routing_decision_route_pool_present: true,
            },
        );
        assert!(decision.default_pool_available);
        assert!(!decision.policy_exhausted);
        assert!(!decision.may_project);
        assert_eq!(decision.reason_code, "default_pool_available");
    }

    #[test]
    fn route_pool_and_default_pool_empty_is_terminal() {
        let decision = resolve_error_err05_route_availability_decision(
            &ErrorErr05RouteAvailabilityDecisionInput {
                route_name: Some("search".to_string()),
                route_pool: vec!["primary".to_string()],
                route_tiers: vec![tier(&["primary"], false)],
                default_route_tiers: vec![tier(&["default-a"], true)],
                excluded_provider_keys: vec!["primary".to_string(), "default-a".to_string()],
                provider_key: Some("primary".to_string()),
                routing_decision_route_pool_present: true,
            },
        );
        assert!(!decision.default_pool_available);
        assert!(decision.policy_exhausted);
        assert!(decision.may_project);
        assert_eq!(decision.reason_code, "route_pool_and_default_empty");
    }

    #[test]
    fn single_configured_candidate_without_default_is_verified_last_provider() {
        let decision = resolve_error_err05_route_availability_decision(
            &ErrorErr05RouteAvailabilityDecisionInput {
                route_name: Some("default".to_string()),
                route_pool: vec!["solo".to_string()],
                route_tiers: vec![tier(&["solo"], false)],
                default_route_tiers: Vec::new(),
                excluded_provider_keys: Vec::new(),
                provider_key: Some("solo".to_string()),
                routing_decision_route_pool_present: true,
            },
        );
        assert!(decision.route_pool_authoritative);
        assert!(decision.verified_last_provider);
        assert!(!decision.has_alternative_candidate);
    }

    #[test]
    fn alternative_candidate_is_reported_from_rust() {
        let decision = resolve_error_err05_route_availability_decision(
            &ErrorErr05RouteAvailabilityDecisionInput {
                route_name: Some("default".to_string()),
                route_pool: vec!["a".to_string(), "b".to_string()],
                route_tiers: vec![tier(&["a", "b"], false)],
                default_route_tiers: Vec::new(),
                excluded_provider_keys: vec!["a".to_string()],
                provider_key: Some("a".to_string()),
                routing_decision_route_pool_present: true,
            },
        );
        assert!(decision.has_alternative_candidate);
        assert_eq!(
            decision.route_pool_remaining_after_exclusion,
            vec!["b".to_string()]
        );
        assert!(decision.route_pool_authoritative);
    }
}
