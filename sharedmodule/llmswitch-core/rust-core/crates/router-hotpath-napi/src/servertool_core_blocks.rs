//! NAPI blocks for servertool-core — stop gateway, loop guard, budget counter.

use servertool_core::backend_route_contract::{
    plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03,
    ServertoolBackendRoutePolicyInput,
};
use servertool_core::cli_contract;
use servertool_core::cli_contract::ServertoolClientVisibleProjectionShellInput;
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

pub fn build_client_exec_cli_projection_output_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize projection input: {e}"))?;
    let tool_name = input
        .get("toolName")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "missing toolName".to_string())?;
    let flow_id = input
        .get("flowId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("servertool_cli_projection");
    let payload = input
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let repeat_count = input
        .get("repeatCount")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let max_repeats = input
        .get("maxRepeats")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let output = cli_contract::build_client_exec_cli_projection_output(
        tool_name,
        flow_id,
        payload,
        repeat_count,
        max_repeats,
    )
    .map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize projection output: {e}"))
}

pub fn build_client_visible_projection_shell_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolClientVisibleProjectionShellInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize projection shell input: {e}"))?;
    let output =
        cli_contract::build_client_visible_projection_shell(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize projection shell: {e}"))
}

pub fn validate_client_exec_command_result_json(raw_output: &str) -> Result<String, String> {
    let output =
        cli_contract::validate_client_exec_command_result(raw_output).map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize command result: {e}"))
}

pub fn plan_servertool_backend_route_policy_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolBackendRoutePolicyInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize backend route input: {e}"))?;
    let output = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(input)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize backend route plan: {e}"))
}

/// Resolve default max repeats.
pub fn resolve_default_max_repeats(
    configured: Option<u32>,
    is_non_active_managed_goal: bool,
) -> u32 {
    stop_message_counter::resolve_default_max_repeats(configured, is_non_active_managed_goal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plans_backend_route_policy_via_servertool_core_bridge() {
        let raw = plan_servertool_backend_route_policy_json(
            &json!({
                "toolName": "web_search",
                "input": { "query": "routecodex" }
            })
            .to_string(),
        )
        .expect("backend route policy");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["toolName"], "web_search");
        assert_eq!(parsed["flowId"], "web_search_flow");
        assert_eq!(parsed["routeHint"], "servertool_backend_route:web_search");
        assert_eq!(parsed["executionMode"], "reenter");
        assert_eq!(parsed["shapeGuard"]["failOnMissingPayload"], true);
    }

    #[test]
    fn backend_route_policy_bridge_rejects_client_exec_tool() {
        let err = plan_servertool_backend_route_policy_json(
            &json!({
                "toolName": "stop_message_auto",
                "input": {}
            })
            .to_string(),
        )
        .expect_err("stop_message_auto is not backend route");
        assert!(err.contains("SERVERTOOL_OUTCOME_MISMATCH"));
    }
}
