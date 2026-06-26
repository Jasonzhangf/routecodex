// feature_id: virtual_router.primary_exhausted_to_default_pool
//! napi JSON bridge for the `primary_exhausted -> default_pool` decision.
//!
//! This is the only function exposed to the host. Selection hot paths MUST
//! go through this contract. Host-side `request-executor` / `http-server` /
//! `RequestExecutor` must NOT locally synthesize a default pool chain; they
//! must consume the JSON returned by `plan_primary_exhausted_to_default_pool_json`
//! and bind the resulting target list to the next selection attempt.
//!
//! Source anchor: `// feature_id: virtual_router.primary_exhausted_to_default_pool`
//! Contract locked at 2026-06-14 (P4 option A).

use crate::virtual_router_engine::routing::{
    plan_primary_exhausted_to_default_pool, PrimaryExhaustedPlanInput,
};
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;

/// Pure plan function exposed to JS host.
///
/// `input_json` MUST be a JSON-serialized `PrimaryExhaustedPlanInput` with
/// `camelCase` keys:
///   - `route: string`
///   - `tiers: Array<{ id: string, targets: string[], priority: number, backup?: boolean }>`
///   - `exhaustedTargets: string[]`
///   - `knownTargets: string[]`
///
/// Returns a JSON-serialized `PrimaryExhaustedToDefaultPoolPlan` with
/// `camelCase` keys:
///   - `status: "no_default_pool_needed" | "default_pool" | "unknown_target" | "route_not_configured"`
///   - `defaultPoolTargets: string[]`
///   - `fromTierId: string | null`
///   - `fromTierPriority: number | null`
///
/// Tiers MUST already be sorted by priority desc by the caller (this matches
/// `parse_routing`'s contract in `config.rs`). The function never mutates input.
#[napi(js_name = "planPrimaryExhaustedToDefaultPoolJson")]
pub fn plan_primary_exhausted_to_default_pool_json(input_json: String) -> NapiResult<String> {
    let input: PrimaryExhaustedPlanInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_primary_exhausted_to_default_pool(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
