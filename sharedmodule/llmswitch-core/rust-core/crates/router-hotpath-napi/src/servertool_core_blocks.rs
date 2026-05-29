//! NAPI blocks for servertool-core — stop gateway, loop guard, budget counter.

use servertool_core::stop_gateway_context;
use servertool_core::stop_message_counter;
use servertool_core::stop_message_loop_guard;

/// Inspect a response payload and return the stop gateway context as JSON.
pub fn inspect_stop_gateway_signal(payload_json: &str) -> Result<String, String> {
    let payload: serde_json::Value =
        serde_json::from_str(payload_json).map_err(|e| format!("deserialize payload: {e}"))?;
    let context = stop_gateway_context::inspect(&payload);
    serde_json::to_string(&context).map_err(|e| format!("serialize context: {e}"))
}

/// Check stop eligibility (returns JSON bool).
pub fn is_stop_eligible(payload_json: &str) -> Result<String, String> {
    let payload: serde_json::Value =
        serde_json::from_str(payload_json).map_err(|e| format!("deserialize payload: {e}"))?;
    let eligible = stop_gateway_context::is_stop_eligible(&payload);
    Ok(if eligible { "true" } else { "false" }.to_string())
}

/// Evaluate stop-message loop guard.
pub fn evaluate_loop_guard(input_json: &str) -> Result<String, String> {
    let input: stop_message_loop_guard::LoopGuardInput =
        serde_json::from_str(input_json).map_err(|e| format!("deserialize LoopGuardInput: {e}"))?;
    let output = stop_message_loop_guard::evaluate(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize output: {e}"))
}

/// Calculate budget after a finish_reason event.
pub fn calculate_budget_json(
    observed: bool,
    stop_eligible: bool,
    snapshot_json: Option<&str>,
    default_config_json: Option<&str>,
) -> Result<String, String> {
    let snapshot = match snapshot_json {
        Some(json) => {
            let s: stop_message_counter::BudgetSnapshot =
                serde_json::from_str(json).map_err(|e| format!("deserialize snapshot: {e}"))?;
            Some(s)
        }
        None => None,
    };
    let config = match default_config_json {
        Some(json) => {
            let c: stop_message_counter::DefaultBudgetConfig =
                serde_json::from_str(json).map_err(|e| format!("deserialize config: {e}"))?;
            Some(c)
        }
        None => None,
    };
    let decision = stop_message_counter::calculate_budget(
        observed,
        stop_eligible,
        snapshot.as_ref(),
        config.as_ref(),
    );
    serde_json::to_string(&decision).map_err(|e| format!("serialize decision: {e}"))
}

/// Resolve default max repeats.
pub fn resolve_default_max_repeats(
    configured: Option<u32>,
    is_non_active_managed_goal: bool,
) -> u32 {
    stop_message_counter::resolve_default_max_repeats(configured, is_non_active_managed_goal)
}
