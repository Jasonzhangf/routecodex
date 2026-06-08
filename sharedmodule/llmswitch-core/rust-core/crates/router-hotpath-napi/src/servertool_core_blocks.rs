//! NAPI blocks for servertool-core — stop gateway, loop guard, budget counter.

use servertool_core::backend_route_contract::{
    decorate_servertool_final_chat_with_context, plan_followup_execution_mode,
    plan_followup_runtime_action, plan_followup_runtime_metadata,
    plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03,
    should_short_circuit_requires_action_followup, ServertoolBackendRouteFinalizeInput,
    ServertoolBackendRoutePolicyInput, ServertoolBackendRouteRequiresActionShortCircuitInput,
    ServertoolFollowupExecutionModeInput, ServertoolFollowupRuntimeActionInput,
    ServertoolFollowupRuntimeMetadataInput,
};
use servertool_core::cli_contract;
use servertool_core::cli_contract::ServertoolClientVisibleProjectionShellInput;
use servertool_core::cli_result_guard;
use servertool_core::persisted_lookup;
use servertool_core::stop_gateway_context;
use servertool_core::stop_message_counter;
use servertool_core::stop_message_loop_guard;
use servertool_core::text_extraction;

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

pub fn plan_budget_state_update_json(input_json: &str) -> Result<String, String> {
    let input: stop_message_counter::BudgetStateUpdateInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize BudgetStateUpdateInput: {e}"))?;
    let plan = stop_message_counter::plan_budget_state_update(input);
    serde_json::to_string(&plan).map_err(|e| format!("serialize budget state update plan: {e}"))
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

pub fn has_stop_message_auto_cli_result_in_request_json(
    input_json: &str,
) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize cli result guard input: {e}"))?;
    Ok(
        if cli_result_guard::has_stop_message_auto_cli_result_in_request(&payload) {
            "true"
        } else {
            "false"
        }
        .to_string(),
    )
}

pub fn resolve_servertool_state_key_json(input_json: &str) -> Result<String, String> {
    let metadata: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool state key metadata: {e}"))?;
    let key = persisted_lookup::resolve_servertool_state_key(&metadata);
    serde_json::to_string(&key).map_err(|e| format!("serialize state key: {e}"))
}

pub fn resolve_runtime_stop_message_state_json(input_json: &str) -> Result<String, String> {
    let metadata: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize runtime stop-message metadata: {e}"))?;
    let snapshot = persisted_lookup::resolve_runtime_stop_message_state(&metadata);
    serde_json::to_string(&snapshot)
        .map_err(|e| format!("serialize runtime stop-message state: {e}"))
}

pub fn read_runtime_stop_message_stage_mode_json(input_json: &str) -> Result<String, String> {
    let metadata: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize runtime stop-message metadata: {e}"))?;
    let stage_mode = persisted_lookup::read_runtime_stop_message_stage_mode(&metadata);
    serde_json::to_string(&stage_mode)
        .map_err(|e| format!("serialize runtime stop-message stage mode: {e}"))
}

pub fn plan_servertool_backend_route_policy_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolBackendRoutePolicyInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize backend route input: {e}"))?;
    let output = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(input)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize backend route plan: {e}"))
}

pub fn decorate_servertool_final_chat_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolBackendRouteFinalizeInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize backend route finalize input: {e}"))?;
    let output = decorate_servertool_final_chat_with_context(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize backend route final chat: {e}"))
}

pub fn should_short_circuit_requires_action_followup_json(
    input_json: &str,
) -> Result<String, String> {
    let input: ServertoolBackendRouteRequiresActionShortCircuitInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize backend route requires_action input: {e}"))?;
    Ok(if should_short_circuit_requires_action_followup(input) {
        "true"
    } else {
        "false"
    }
    .to_string())
}

pub fn plan_followup_execution_mode_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolFollowupExecutionModeInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize followup execution mode input: {e}"))?;
    let output = plan_followup_execution_mode(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize execution mode plan: {e}"))
}

pub fn plan_followup_runtime_action_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolFollowupRuntimeActionInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize followup runtime action input: {e}"))?;
    let output = plan_followup_runtime_action(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize runtime action plan: {e}"))
}

pub fn plan_followup_runtime_metadata_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolFollowupRuntimeMetadataInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize followup runtime metadata input: {e}"))?;
    let output = plan_followup_runtime_metadata(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize runtime metadata plan: {e}"))
}

pub fn extract_text_from_chat_like_json(input_json: &str) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize text extraction payload: {e}"))?;
    let text = text_extraction::extract_text_from_chat_like(&payload);
    serde_json::to_string(&text).map_err(|e| format!("serialize extracted text: {e}"))
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

    #[test]
    fn resolves_servertool_state_key_via_servertool_core_bridge() {
        let raw = resolve_servertool_state_key_json(
            &json!({
                "continuation": {
                    "stickyScope": "request_chain",
                    "resumeFrom": { "requestId": "req-parent" }
                },
                "sessionId": "session-should-lose",
                "requestId": "req-child"
            })
            .to_string(),
        )
        .expect("state key");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, "req-parent");
    }

    #[test]
    fn resolves_runtime_stop_message_state_via_servertool_core_bridge() {
        let raw = resolve_runtime_stop_message_state_json(
            &json!({
                "serverToolLoopState": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 99,
                    "maxRepeats": 3
                }
            })
            .to_string(),
        )
        .expect("runtime stop state");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["text"], "继续执行");
        assert_eq!(parsed["maxRepeats"], 3);
        assert_eq!(parsed["used"], 0);
        assert_eq!(parsed["source"], "servertool.stop_message");
        assert_eq!(parsed["stageMode"], "on");
    }

    #[test]
    fn reads_runtime_stop_message_stage_mode_via_servertool_core_bridge() {
        let raw = read_runtime_stop_message_stage_mode_json(
            &json!({
                "stopMessageState": {
                    "stopMessageStageMode": " AUTO "
                }
            })
            .to_string(),
        )
        .expect("stage mode");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, "auto");
    }

    #[test]
    fn decorates_final_chat_via_servertool_core_bridge() {
        let raw = decorate_servertool_final_chat_json(
            &json!({
                "chat": {
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": { "role": "assistant", "content": null }
                    }]
                },
                "execution": {
                    "flowId": "continue_execution_flow",
                    "context": { "continue_execution": { "visibleSummary": "ok" } }
                },
                "decision": { "contextDecorationMode": "continue_execution_summary" }
            })
            .to_string(),
        )
        .expect("finalize bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["choices"][0]["message"]["content"], "ok");
        assert_eq!(parsed["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn requires_action_short_circuit_bridge_returns_bool_json() {
        let raw = should_short_circuit_requires_action_followup_json(
            &json!({
                "flowId": "stop_message_flow",
                "decision": { "ignoreRequiresActionFollowup": true },
                "hasRequiresActionShape": true
            })
            .to_string(),
        )
        .expect("requires action bridge");
        assert_eq!(raw, "true");
    }

    #[test]
    fn plans_followup_execution_mode_via_servertool_core_bridge() {
        let raw = plan_followup_execution_mode_json(
            &json!({
                "flowId": "continue_execution_flow",
                "decision": {
                    "outcomeMode": "reenter",
                    "noFollowup": false,
                    "clientInjectOnly": false
                },
                "metadataClientInjectOnly": true,
                "clientInjectSource": null
            })
            .to_string(),
        )
        .expect("execution mode bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["flowId"], "continue_execution_flow");
        assert_eq!(parsed["executionMode"], "client_inject_only");
    }

    #[test]
    fn plans_followup_runtime_action_via_servertool_core_bridge() {
        let raw = plan_followup_runtime_action_json(
            &json!({
                "flowId": "stop_message_flow",
                "decision": {
                    "outcomeMode": "reenter",
                    "noFollowup": false,
                    "autoLimit": true,
                    "clientInjectOnly": true,
                    "seedLoopPayload": true,
                    "clientInjectSource": "servertool.continue_execution"
                },
                "metadataClientInjectOnly": false,
                "hasFollowupPayloadRaw": false,
                "loopStateRepeatCount": 3,
                "clientInjectSource": null
            })
            .to_string(),
        )
        .expect("runtime action bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["flowId"], "stop_message_flow");
        assert_eq!(parsed["loopPayloadSource"], "seed_loop_payload");
        assert_eq!(parsed["autoLimit"]["exceeded"], true);
        assert_eq!(parsed["autoLimit"]["status"], 502);
        assert_eq!(parsed["clientInjectMetadata"]["force"], true);
        assert_eq!(
            parsed["clientInjectMetadata"]["source"],
            "servertool.continue_execution"
        );
    }

    #[test]
    fn plans_followup_runtime_metadata_via_servertool_core_bridge() {
        let raw = plan_followup_runtime_metadata_json(
            &json!({
                "metadata": {},
                "metadataRuntime": null,
                "adapterContext": {
                    "routecodexPortMode": "router",
                    "routeId": "coding"
                },
                "adapterRuntime": null,
                "loopState": {
                    "repeatCount": 1
                },
                "originalEntryEndpoint": "/v1/responses",
                "followupEntryEndpoint": "/v1/responses"
            })
            .to_string(),
        )
        .expect("runtime metadata bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["rootSet"]["routeHint"], "coding");
        assert_eq!(parsed["rootSet"]["stream"], false);
        assert_eq!(parsed["runtimeSet"]["serverToolFollowup"], true);
        assert_eq!(
            parsed["runtimeSet"]["serverToolLoopState"]["repeatCount"],
            1
        );
        assert_eq!(parsed["rootDelete"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn extracts_text_from_chat_like_via_servertool_core_bridge() {
        let raw = extract_text_from_chat_like_json(
            &json!({
                "response": {
                    "output": [{
                        "content": [{ "type": "output_text", "text": "ok" }]
                    }]
                }
            })
            .to_string(),
        )
        .expect("text extraction bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, json!("ok"));
    }

    #[test]
    fn detects_stop_message_auto_cli_result_via_servertool_core_bridge() {
        let raw = has_stop_message_auto_cli_result_in_request_json(
            &json!({
                "adapterContext": {
                    "__raw_request_body": {
                        "input": [{
                            "type": "function_call_output",
                            "call_id": "call_servertool",
                            "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\"}"
                        }]
                    }
                }
            })
            .to_string(),
        )
        .expect("cli result guard bridge");
        assert_eq!(raw, "true");
    }

    #[test]
    fn plans_budget_state_update_via_servertool_core_bridge() {
        let raw = plan_budget_state_update_json(
            &json!({
                "stopSignal": {
                    "observed": true,
                    "eligible": true,
                    "reason": "finish_reason_stop"
                },
                "existingState": { "stopMessageUsed": 1 },
                "snapshot": {
                    "text": "继续执行",
                    "max_repeats": 3,
                    "used": 1,
                    "source": "persisted"
                },
                "defaultConfig": null,
                "nowMs": 1234
            })
            .to_string(),
        )
        .expect("budget state update bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["shouldPersist"], true);
        assert_eq!(parsed["used"], 2);
        assert_eq!(parsed["nextState"]["stopMessageUsed"], 2);
    }
}
