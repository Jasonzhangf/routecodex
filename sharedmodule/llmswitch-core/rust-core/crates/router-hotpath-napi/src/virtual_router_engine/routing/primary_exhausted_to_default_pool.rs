// feature_id: virtual_router.primary_exhausted_to_default_pool
//! Contract for `primary_exhausted -> default_pool` selection.
//!
//! This module is the unique owner of the explicit
//! "primary tier exhausted -> next tier (default pool)" decision. Host-side
//! `request-executor` / `http-server` / `RequestExecutor` must NOT locally
//! synthesize a default pool chain; they must consume the JSON returned by
//! `plan_primary_exhausted_to_default_pool` and bind the resulting target list
//! to the next selection attempt.
//!
//! The plan is purely declarative: given the current route name, the
//! configured `RoutePoolTier` list for that route (already sorted by
//! priority desc), and the set of targets that have already been tried or
//! excluded in this request, return the next tier to attempt as the
//! "default pool".
//!
//! Rules (locked at 2026-06-14, P4 option A):
//! 1. The first tier (`primary`) is defined as the highest-priority tier
//!    with `backup != true`. If the primary tier still has an
//!    available target, the plan is `NoDefaultPoolNeeded`.
//! 2. Once every target of the primary tier is in `exhaustedTargets`, the
//!    plan is the first subsequent tier whose `backup == true` (or, if
//!    none, an empty default pool list, meaning the host must fail fast
//!    and never silently pick a non-declared target).
//! 3. A `target` referenced by the selected tier but missing from
//!    `knownTargets` is a configuration error; the plan must surface
//!    `UnknownTarget` instead of guessing.
//!
//! All decisions are JSON-serializable; this is the only function exposed
//! to the host. Selection hot paths MUST go through this contract.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrimaryExhaustedPlanStatus {
    /// Primary tier still has available targets; no default pool needed.
    NoDefaultPoolNeeded,
    /// Primary tier is exhausted; default pool is the list below.
    DefaultPool,
    /// A target referenced by a tier is not present in knownTargets.
    UnknownTarget,
    /// The route is not present in the configured pools.
    RouteNotConfigured,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryExhaustedToDefaultPoolPlan {
    pub status: PrimaryExhaustedPlanStatus,
    pub default_pool_targets: Vec<String>,
    pub from_tier_id: Option<String>,
    pub from_tier_priority: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryExhaustedPlanInput {
    pub route: String,
    pub tiers: Vec<RoutePoolTierInput>,
    pub exhausted_targets: Vec<String>,
    pub known_targets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePoolTierInput {
    pub id: String,
    pub targets: Vec<String>,
    pub priority: i64,
    #[serde(default)]
    pub backup: Option<bool>,
}

/// Pure plan function. Tiers MUST already be sorted by priority desc by the
/// caller (this matches `parse_routing`'s contract in `config.rs`). The
/// function never mutates input.
pub fn plan_primary_exhausted_to_default_pool(
    input: &PrimaryExhaustedPlanInput,
) -> PrimaryExhaustedToDefaultPoolPlan {
    let known: HashSet<&str> = input.known_targets.iter().map(|s| s.as_str()).collect();
    let exhausted: HashSet<&str> = input.exhausted_targets.iter().map(|s| s.as_str()).collect();

    if input.tiers.is_empty() {
        return PrimaryExhaustedToDefaultPoolPlan {
            status: PrimaryExhaustedPlanStatus::RouteNotConfigured,
            default_pool_targets: Vec::new(),
            from_tier_id: None,
            from_tier_priority: None,
        };
    }

    // Caller contract: tiers sorted by priority desc.
    let primary = &input.tiers[0];
    let primary_is_backup = primary.backup.unwrap_or(false);
    let primary_has_remaining = primary
        .targets
        .iter()
        .any(|target| known.contains(target.as_str()) && !exhausted.contains(target.as_str()));

    if !primary_is_backup && primary_has_remaining {
        return PrimaryExhaustedToDefaultPoolPlan {
            status: PrimaryExhaustedPlanStatus::NoDefaultPoolNeeded,
            default_pool_targets: Vec::new(),
            from_tier_id: Some(primary.id.clone()),
            from_tier_priority: Some(primary.priority),
        };
    }

    // Primary exhausted. Find the first backup tier with at least one
    // known + non-exhausted target.
    for tier in input
        .tiers
        .iter()
        .skip(if primary_is_backup { 0 } else { 1 })
    {
        if !tier.backup.unwrap_or(false) {
            continue;
        }
        let mut valid: Vec<String> = Vec::new();
        let mut unknown = false;
        for target in &tier.targets {
            if !known.contains(target.as_str()) {
                unknown = true;
                break;
            }
            if !exhausted.contains(target.as_str()) {
                valid.push(target.clone());
            }
        }
        if unknown {
            return PrimaryExhaustedToDefaultPoolPlan {
                status: PrimaryExhaustedPlanStatus::UnknownTarget,
                default_pool_targets: Vec::new(),
                from_tier_id: Some(tier.id.clone()),
                from_tier_priority: Some(tier.priority),
            };
        }
        if !valid.is_empty() {
            return PrimaryExhaustedToDefaultPoolPlan {
                status: PrimaryExhaustedPlanStatus::DefaultPool,
                default_pool_targets: valid,
                from_tier_id: Some(tier.id.clone()),
                from_tier_priority: Some(tier.priority),
            };
        }
    }

    PrimaryExhaustedToDefaultPoolPlan {
        status: PrimaryExhaustedPlanStatus::DefaultPool,
        default_pool_targets: Vec::new(),
        from_tier_id: None,
        from_tier_priority: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tier(
        id: &str,
        priority: i64,
        targets: Vec<&str>,
        backup: Option<bool>,
    ) -> RoutePoolTierInput {
        RoutePoolTierInput {
            id: id.to_string(),
            priority,
            targets: targets.into_iter().map(|s| s.to_string()).collect(),
            backup,
        }
    }

    #[test]
    fn primary_tier_with_remaining_target_returns_no_default_pool_needed() {
        let input = PrimaryExhaustedPlanInput {
            route: "default".to_string(),
            tiers: vec![
                tier("primary", 200, vec!["fwd.a", "fwd.b"], None),
                tier("backup", 100, vec!["fwd.c"], Some(true)),
            ],
            exhausted_targets: vec!["fwd.b".to_string()],
            known_targets: vec![
                "fwd.a".to_string(),
                "fwd.b".to_string(),
                "fwd.c".to_string(),
            ],
        };
        let plan = plan_primary_exhausted_to_default_pool(&input);
        assert_eq!(plan.status, PrimaryExhaustedPlanStatus::NoDefaultPoolNeeded);
        assert!(plan.default_pool_targets.is_empty());
        assert_eq!(plan.from_tier_id.as_deref(), Some("primary"));
    }

    #[test]
    fn primary_exhausted_returns_default_pool_from_first_backup_tier() {
        let input = PrimaryExhaustedPlanInput {
            route: "default".to_string(),
            tiers: vec![
                tier("primary", 200, vec!["fwd.a", "fwd.b"], None),
                tier("backup", 100, vec!["fwd.c"], Some(true)),
            ],
            exhausted_targets: vec!["fwd.a".to_string(), "fwd.b".to_string()],
            known_targets: vec![
                "fwd.a".to_string(),
                "fwd.b".to_string(),
                "fwd.c".to_string(),
            ],
        };
        let plan = plan_primary_exhausted_to_default_pool(&input);
        assert_eq!(plan.status, PrimaryExhaustedPlanStatus::DefaultPool);
        assert_eq!(plan.default_pool_targets, vec!["fwd.c".to_string()]);
        assert_eq!(plan.from_tier_id.as_deref(), Some("backup"));
    }

    #[test]
    fn unknown_target_in_backup_tier_returns_unknown_target_status() {
        let input = PrimaryExhaustedPlanInput {
            route: "default".to_string(),
            tiers: vec![
                tier("primary", 200, vec!["fwd.a"], None),
                tier("backup", 100, vec!["fwd.b", "fwd.missing"], Some(true)),
            ],
            exhausted_targets: vec!["fwd.a".to_string()],
            known_targets: vec!["fwd.a".to_string(), "fwd.b".to_string()],
        };
        let plan = plan_primary_exhausted_to_default_pool(&input);
        assert_eq!(plan.status, PrimaryExhaustedPlanStatus::UnknownTarget);
        assert!(plan.default_pool_targets.is_empty());
    }

    #[test]
    fn no_backup_tier_returns_empty_default_pool_with_default_pool_status() {
        let input = PrimaryExhaustedPlanInput {
            route: "default".to_string(),
            tiers: vec![tier("primary", 200, vec!["fwd.a"], None)],
            exhausted_targets: vec!["fwd.a".to_string()],
            known_targets: vec!["fwd.a".to_string()],
        };
        let plan = plan_primary_exhausted_to_default_pool(&input);
        assert_eq!(plan.status, PrimaryExhaustedPlanStatus::DefaultPool);
        assert!(plan.default_pool_targets.is_empty());
        assert_eq!(plan.from_tier_id, None);
    }

    #[test]
    fn empty_route_returns_route_not_configured() {
        let input = PrimaryExhaustedPlanInput {
            route: "absent".to_string(),
            tiers: vec![],
            exhausted_targets: vec![],
            known_targets: vec![],
        };
        let plan = plan_primary_exhausted_to_default_pool(&input);
        assert_eq!(plan.status, PrimaryExhaustedPlanStatus::RouteNotConfigured);
    }
}
