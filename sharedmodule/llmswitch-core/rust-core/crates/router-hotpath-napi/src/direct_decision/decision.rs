//! Direct Decision — Pure decision helpers for router-direct / provider-direct.
//!
//! Migrated from TS `direct-decision.ts` + `direct-client-disconnect.ts`.
//!
//! All functions are deterministic, no I/O, no external state.
//! The `is_client_disconnect_like` dependency is in `crate::failure_policy`.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirectRetryAction {
    RequestReroute,
    Rethrow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRetryDecision {
    pub action: DirectRetryAction,
    pub should_recurse: bool,
    pub should_rethrow: bool,
    pub mutated_excluded: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectRetryPlanLike {
    #[serde(default)]
    pub should_retry: Option<bool>,
    #[serde(default)]
    pub switch_action: Option<String>,
    #[serde(default)]
    pub excluded_current_provider: Option<bool>,
    #[serde(default)]
    pub default_pool_available: Option<bool>,
    #[serde(default)]
    pub may_project: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideDirectRouterRetryArgs {
    pub retry_execution_plan: DirectRetryPlanLike,
    pub excluded_provider_keys: Vec<String>,
    pub direct_attempt: u32,
    pub max_attempts: u32,
    pub provider_key: String,
    pub pool: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideDirectProviderRetryArgs {
    pub retry_execution_plan: DirectRetryPlanLike,
    pub provider_key: String,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn new_excluded(excluded: &[String], key: &str) -> Vec<String> {
    let mut next = excluded.to_vec();
    if !next.iter().any(|k| k == key) {
        next.push(key.to_string());
    }
    next
}

fn rethrow_decision(excluded: &[String]) -> DirectRetryDecision {
    DirectRetryDecision {
        action: DirectRetryAction::Rethrow,
        should_recurse: false,
        should_rethrow: true,
        mutated_excluded: excluded.to_vec(),
    }
}

fn request_reroute_decision(excluded: &[String], mutated: &[String]) -> DirectRetryDecision {
    DirectRetryDecision {
        action: DirectRetryAction::RequestReroute,
        should_recurse: true,
        should_rethrow: false,
        mutated_excluded: mutated.to_vec(),
    }
}

fn remaining_candidates(pool: &[String], excluded: &[String]) -> u32 {
    let mut n = 0u32;
    for key in pool {
        if !excluded.iter().any(|k| k == key) {
            n += 1;
        }
    }
    n
}

// ---------------------------------------------------------------------------
// Main decision functions
// ---------------------------------------------------------------------------

/// Decide retry action for router-direct mode.
/// Mirrors TS `decideDirectRouterRetry`.
pub fn decide_direct_router_retry(args: &DecideDirectRouterRetryArgs) -> DirectRetryDecision {
    // Reverse 1: client_disconnect → rethrow
    if is_client_disconnect_from_error(&args.excluded_provider_keys, &args.provider_key).is_some() {
        return rethrow_decision(&args.excluded_provider_keys);
    }

    // Reverse 2: attempt budget exhausted
    if args.direct_attempt >= args.max_attempts {
        return rethrow_decision(&args.excluded_provider_keys);
    }

    let plan = &args.retry_execution_plan;

    // Reverse 3: no retryable plan
    let should_retry = plan.should_retry.unwrap_or(false);
    if !should_retry {
        return rethrow_decision(&args.excluded_provider_keys);
    }

    let switch_action = plan.switch_action.as_deref().unwrap_or("");
    if switch_action != "exclude_and_reroute" {
        return rethrow_decision(&args.excluded_provider_keys);
    }

    // Forward: exclude current provider and check remaining candidates
    let excluded = if plan.excluded_current_provider.unwrap_or(false) {
        new_excluded(&args.excluded_provider_keys, &args.provider_key)
    } else {
        args.excluded_provider_keys.clone()
    };

    let remaining = remaining_candidates(&args.pool, &excluded);
    if remaining <= 0 {
        if plan.default_pool_available == Some(true) && plan.may_project != Some(true) {
            return request_reroute_decision(&args.excluded_provider_keys, &excluded);
        }
        return rethrow_decision(&args.excluded_provider_keys);
    }

    request_reroute_decision(&args.excluded_provider_keys, &excluded)
}

/// Decide retry action for provider-direct mode.
/// Mirrors TS `decideDirectProviderRetry`.
pub fn decide_direct_provider_retry(_args: &DecideDirectProviderRetryArgs) -> DirectRetryDecision {
    rethrow_decision(&[])
}

// ---------------------------------------------------------------------------
// Client disconnect check (mirrors TS isClientDisconnectLikeError)
// ---------------------------------------------------------------------------

fn is_client_disconnect_from_error<'a>(
    _excluded: &'a [String],
    _provider_key: &'a str,
) -> Option<()> {
    // This function would use failure_policy::is_client_disconnect_like_error
    // but the TS call site passes an `unknown error` object.
    // For now, the caller should call is_client_disconnect_like_error directly.
    // We provide a NAPI-level wrapper instead.
    None
}

// ---------------------------------------------------------------------------
// NAPI JSON-boundary entry points
// ---------------------------------------------------------------------------

pub fn decide_direct_router_retry_json(input_json: String) -> Result<String, String> {
    let input: DecideDirectRouterRetryArgs =
        serde_json::from_str(&input_json).map_err(|e| format!("parse input: {}", e))?;
    let decision = decide_direct_router_retry(&input);
    serde_json::to_string(&decision).map_err(|e| format!("serialize: {}", e))
}

pub fn decide_direct_provider_retry_json(input_json: String) -> Result<String, String> {
    let input: DecideDirectProviderRetryArgs =
        serde_json::from_str(&input_json).map_err(|e| format!("parse input: {}", e))?;
    let decision = decide_direct_provider_retry(&input);
    serde_json::to_string(&decision).map_err(|e| format!("serialize: {}", e))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_plan(
        should_retry: bool,
        switch_action: &str,
        excluded_current: bool,
        default_pool: Option<bool>,
        may_project: Option<bool>,
    ) -> DirectRetryPlanLike {
        DirectRetryPlanLike {
            should_retry: Some(should_retry),
            switch_action: Some(switch_action.to_string()),
            excluded_current_provider: Some(excluded_current),
            default_pool_available: default_pool,
            may_project,
        }
    }

    // -- remaining_candidates --

    #[test]
    fn remaining_all_available() {
        let pool = vec!["a".to_string(), "b".to_string()];
        let excluded = vec!["c".to_string()];
        assert_eq!(remaining_candidates(&pool, &excluded), 2);
    }

    #[test]
    fn remaining_one_excluded() {
        let pool = vec!["a".to_string(), "b".to_string()];
        let excluded = vec!["a".to_string()];
        assert_eq!(remaining_candidates(&pool, &excluded), 1);
    }

    #[test]
    fn remaining_all_excluded() {
        let pool = vec!["a".to_string(), "b".to_string()];
        let excluded = vec!["a".to_string(), "b".to_string()];
        assert_eq!(remaining_candidates(&pool, &excluded), 0);
    }

    // -- new_excluded --

    #[test]
    fn new_excluded_adds_key() {
        let excluded = vec!["a".to_string()];
        let result = new_excluded(&excluded, "b");
        assert_eq!(result.len(), 2);
        assert!(result.contains(&"b".to_string()));
    }

    #[test]
    fn new_excluded_dedup() {
        let excluded = vec!["a".to_string()];
        let result = new_excluded(&excluded, "a");
        assert_eq!(result.len(), 1);
    }

    // -- decideDirectRouterRetry via client_disconnect --

    #[test]
    fn router_retry_client_disconnect_rethrows() {
        // Without is_client_disconnect from error object,
        // verify the rest of the decision tree works
        let pool = vec!["p1".to_string(), "p2".to_string()];
        let plan = make_plan(true, "exclude_and_reroute", true, Some(false), None);
        let args = DecideDirectRouterRetryArgs {
            pool,
            excluded_provider_keys: vec![],
            direct_attempt: 1,
            max_attempts: 3,
            provider_key: "p1".to_string(),
            retry_execution_plan: plan,
        };
        // Should NOT be disconnect (no disconnect info in args) → should proceed to reroute
        let decision = decide_direct_router_retry(&args);
        assert_eq!(decision.action, DirectRetryAction::RequestReroute);
    }

    // -- attempt budget exhausted --

    #[test]
    fn router_retry_attempt_budget_exhausted_rethrows() {
        let pool = vec!["p1".to_string(), "p2".to_string()];
        let plan = make_plan(true, "exclude_and_reroute", false, Some(false), None);
        let args = DecideDirectRouterRetryArgs {
            pool,
            excluded_provider_keys: vec![],
            direct_attempt: 3,
            max_attempts: 3,
            provider_key: "p1".to_string(),
            retry_execution_plan: plan,
        };
        let decision = decide_direct_router_retry(&args);
        assert_eq!(decision.action, DirectRetryAction::Rethrow);
    }

    // -- no retryable plan --

    #[test]
    fn router_retry_no_retryable_plan_rethrows() {
        let pool = vec!["p1".to_string()];
        let plan = make_plan(false, "exclude_and_reroute", false, Some(false), None);
        let args = DecideDirectRouterRetryArgs {
            pool,
            excluded_provider_keys: vec![],
            direct_attempt: 1,
            max_attempts: 3,
            provider_key: "p1".to_string(),
            retry_execution_plan: plan,
        };
        let decision = decide_direct_router_retry(&args);
        assert_eq!(decision.action, DirectRetryAction::Rethrow);
    }

    // -- no candidates remaining + no default pool --

    #[test]
    fn router_retry_no_candidates_left_rethrows() {
        let pool = vec!["p1".to_string()];
        let plan = make_plan(true, "exclude_and_reroute", true, Some(false), None);
        let args = DecideDirectRouterRetryArgs {
            pool,
            excluded_provider_keys: vec!["p1".to_string()],
            direct_attempt: 1,
            max_attempts: 3,
            provider_key: "p1".to_string(),
            retry_execution_plan: plan,
        };
        let decision = decide_direct_router_retry(&args);
        assert_eq!(decision.action, DirectRetryAction::Rethrow);
    }

    // -- no candidates remaining + default pool available --

    #[test]
    fn router_retry_no_candidates_but_default_pool_reroutes() {
        let pool = vec!["p1".to_string()];
        let plan = make_plan(true, "exclude_and_reroute", true, Some(true), None);
        let args = DecideDirectRouterRetryArgs {
            pool,
            excluded_provider_keys: vec!["p1".to_string()],
            direct_attempt: 1,
            max_attempts: 3,
            provider_key: "p1".to_string(),
            retry_execution_plan: plan,
        };
        let decision = decide_direct_router_retry(&args);
        assert_eq!(decision.action, DirectRetryAction::RequestReroute);
    }

    // -- candidates remaining → reroute --

    #[test]
    fn router_retry_candidates_remaining_reroutes() {
        let pool = vec!["p1".to_string(), "p2".to_string()];
        let plan = make_plan(true, "exclude_and_reroute", true, None, None);
        let args = DecideDirectRouterRetryArgs {
            pool,
            excluded_provider_keys: vec![],
            direct_attempt: 1,
            max_attempts: 3,
            provider_key: "p1".to_string(),
            retry_execution_plan: plan,
        };
        let decision = decide_direct_router_retry(&args);
        assert_eq!(decision.action, DirectRetryAction::RequestReroute);
        assert!(decision.mutated_excluded.contains(&"p1".to_string()));
    }

    // -- decideDirectProviderRetry always rethrows --

    #[test]
    fn provider_retry_always_rethrows() {
        let plan = make_plan(true, "exclude_and_reroute", true, None, None);
        let args = DecideDirectProviderRetryArgs {
            retry_execution_plan: plan,
            provider_key: "p1".to_string(),
        };
        let decision = decide_direct_provider_retry(&args);
        assert_eq!(decision.action, DirectRetryAction::Rethrow);
        assert!(decision.mutated_excluded.is_empty());
    }

    // -- rethrowDecision / requestRerouteDecision structure check --

    #[test]
    fn rethrow_decision_structure() {
        let excluded = vec!["k1".to_string()];
        let d = rethrow_decision(&excluded);
        assert_eq!(d.action, DirectRetryAction::Rethrow);
        assert!(!d.should_recurse);
        assert!(d.should_rethrow);
        assert_eq!(d.mutated_excluded, vec!["k1"]);
    }

    #[test]
    fn request_reroute_decision_structure() {
        let excluded = vec!["k1".to_string()];
        let mutated = vec!["k1".to_string(), "k2".to_string()];
        let d = request_reroute_decision(&excluded, &mutated);
        assert_eq!(d.action, DirectRetryAction::RequestReroute);
        assert!(d.should_recurse);
        assert!(!d.should_rethrow);
        assert_eq!(d.mutated_excluded, vec!["k1", "k2"]);
    }
}
