//! NAPI blocks for servertool-core — stop gateway, loop guard, budget counter.

use servertool_core::backend_route_contract::{
    decorate_servertool_final_chat_with_context, plan_bootstrap_replay,
    plan_followup_error_envelope, plan_followup_execution_mode, plan_followup_materialization,
    plan_followup_runtime_action, plan_followup_runtime_metadata,
    plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03, plan_vision_eligibility,
    should_short_circuit_requires_action_followup, ServertoolBackendRouteFinalizeInput,
    ServertoolBackendRoutePolicyInput, ServertoolBackendRouteRequiresActionShortCircuitInput,
    ServertoolBootstrapReplayPlanInput, ServertoolFollowupErrorPlanInput,
    ServertoolFollowupExecutionModeInput, ServertoolFollowupMaterializationInput,
    ServertoolFollowupRuntimeActionInput, ServertoolFollowupRuntimeMetadataInput,
    ServertoolVisionEligibilityInput,
};
use servertool_core::cli_contract;
use servertool_core::cli_contract::ServertoolClientVisibleProjectionShellInput;
use servertool_core::cli_result_guard;
use servertool_core::engine_selection_contract;
use servertool_core::loop_state_contract;
use servertool_core::orchestration_policy_contract;
use servertool_core::pending_session_contract;
use servertool_core::persisted_lookup;
use servertool_core::pre_command_hook_contract;
use servertool_core::stop_gateway_context;
use servertool_core::stop_message_compare_context;
use servertool_core::stop_message_counter;
use servertool_core::stop_message_default_config;
use servertool_core::stop_message_loop_guard;
use servertool_core::stop_visible_text;
use servertool_core::stopless_decision_context_goal;
use servertool_core::stopless_decision_context_signals;
use servertool_core::stopless_goal_state_contract;
use servertool_core::stopless_orchestration_contract;
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

pub fn normalize_stop_gateway_context_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize stop gateway context input: {e}"))?;
    let context = stop_gateway_context::normalize_stop_gateway_context(&input);
    serde_json::to_string(&context).map_err(|e| format!("serialize stop gateway context: {e}"))
}

pub fn normalize_stop_message_compare_context_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize stop-message compare context input: {e}"))?;
    let context = stop_message_compare_context::normalize_stop_message_compare_context(&input);
    serde_json::to_string(&context)
        .map_err(|e| format!("serialize stop-message compare context: {e}"))
}

pub fn format_stop_message_compare_context_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize stop-message compare format input: {e}"))?;
    serde_json::to_string(
        &stop_message_compare_context::format_stop_message_compare_context(Some(&input)),
    )
    .map_err(|e| format!("serialize stop-message compare format: {e}"))
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

pub fn resolve_servertool_state_key_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool state key input: {e}"))?;
    serde_json::to_string(&persisted_lookup::resolve_servertool_state_key(&input))
        .map_err(|e| format!("serialize servertool state key: {e}"))
}

pub fn resolve_runtime_stop_message_state_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize runtime stop-message state input: {e}"))?;
    let snapshot = persisted_lookup::resolve_runtime_stop_message_state(&input);
    serde_json::to_string(&snapshot)
        .map_err(|e| format!("serialize runtime stop-message state: {e}"))
}

pub fn resolve_runtime_stop_message_state_from_adapter_context_json(
    input_json: &str,
) -> Result<String, String> {
    let input: persisted_lookup::RuntimeStopMessageStateFromAdapterContextInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize runtime stop-message adapter context input: {e}"))?;
    let snapshot =
        persisted_lookup::resolve_runtime_stop_message_state_from_adapter_context(&input);
    serde_json::to_string(&snapshot)
        .map_err(|e| format!("serialize runtime stop-message adapter context state: {e}"))
}

pub fn read_runtime_stop_message_stage_mode_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize runtime stop-message stage mode input: {e}"))?;
    let stage_mode = persisted_lookup::read_runtime_stop_message_stage_mode(&input);
    serde_json::to_string(&stage_mode)
        .map_err(|e| format!("serialize runtime stop-message stage mode: {e}"))
}

pub fn normalize_stop_message_stage_mode_value_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize stop-message stage mode input: {e}"))?;
    serde_json::to_string(&persisted_lookup::normalize_stop_message_stage_mode_value(
        &input,
    ))
    .map_err(|e| format!("serialize stop-message stage mode: {e}"))
}

pub fn has_armed_stop_message_state_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize armed stop-message state input: {e}"))?;
    Ok(if persisted_lookup::has_armed_stop_message_state(&input) {
        "true"
    } else {
        "false"
    }
    .to_string())
}

pub fn plan_stop_message_routing_snapshot_json(input_json: &str) -> Result<String, String> {
    let input: persisted_lookup::StopMessageRoutingSnapshotPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message routing snapshot input: {e}"))?;
    serde_json::to_string(&persisted_lookup::plan_stop_message_routing_snapshot(
        &input,
    ))
    .map_err(|e| format!("serialize stop-message routing snapshot: {e}"))
}

pub fn plan_stop_message_persisted_state_selection_json(
    input_json: &str,
) -> Result<String, String> {
    let input: persisted_lookup::StopMessagePersistedStateSelectionInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize persisted stop-message state selection input: {e}")
        })?;
    serde_json::to_string(&persisted_lookup::plan_stop_message_persisted_state_selection(&input))
        .map_err(|e| format!("serialize persisted stop-message state selection: {e}"))
}

pub fn plan_stop_message_routing_state_apply_json(input_json: &str) -> Result<String, String> {
    let input: persisted_lookup::StopMessageRoutingStateApplyPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message routing apply input: {e}"))?;
    let plan = persisted_lookup::plan_stop_message_routing_state_apply(&input)?;
    serde_json::to_string(&plan)
        .map_err(|e| format!("serialize stop-message routing apply plan: {e}"))
}

pub fn plan_stop_message_routing_state_clear_json(input_json: &str) -> Result<String, String> {
    let input: persisted_lookup::StopMessageRoutingStateClearPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message routing clear input: {e}"))?;
    serde_json::to_string(&persisted_lookup::plan_stop_message_routing_state_clear(
        &input,
    ))
    .map_err(|e| format!("serialize stop-message routing clear plan: {e}"))
}

pub fn plan_stopless_decision_context_signals_json(input_json: &str) -> Result<String, String> {
    let input: stopless_decision_context_signals::StoplessDecisionContextSignalsInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stopless decision context signals input: {e}"))?;
    serde_json::to_string(
        &stopless_decision_context_signals::plan_stopless_decision_context_signals(&input),
    )
    .map_err(|e| format!("serialize stopless decision context signals: {e}"))
}

pub fn plan_stopless_decision_context_goal_status_json(input_json: &str) -> Result<String, String> {
    let input: stopless_decision_context_goal::StoplessDecisionContextGoalInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stopless decision context goal input: {e}"))?;
    serde_json::to_string(
        &stopless_decision_context_goal::plan_stopless_decision_context_goal_status(&input),
    )
    .map_err(|e| format!("serialize stopless decision context goal plan: {e}"))
}

pub fn plan_stop_message_default_config_json(input_json: &str) -> Result<String, String> {
    let input: stop_message_default_config::StopMessageDefaultConfigInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message default config input: {e}"))?;
    serde_json::to_string(&stop_message_default_config::plan_stop_message_default_config(&input))
        .map_err(|e| format!("serialize stop-message default config plan: {e}"))
}

pub fn plan_stopless_goal_state_sync_json(input_json: &str) -> Result<String, String> {
    let input: stopless_goal_state_contract::StoplessGoalStateSyncPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stopless goal state sync input: {e}"))?;
    let plan = stopless_goal_state_contract::plan_stopless_goal_state_sync(input)?;
    serde_json::to_string(&plan).map_err(|e| format!("serialize stopless goal state plan: {e}"))
}

pub fn read_servertool_followup_flow_id_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool followup flow id input: {e}"))?;
    serde_json::to_string(&persisted_lookup::read_servertool_followup_flow_id(&input))
        .map_err(|e| format!("serialize servertool followup flow id: {e}"))
}

pub fn resolve_bd_working_directory_for_record_json(input_json: &str) -> Result<String, String> {
    let input: persisted_lookup::ServertoolRecordRuntimeMetadataInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize bd working directory input: {e}"))?;
    serde_json::to_string(&persisted_lookup::resolve_bd_working_directory_for_record(
        &input,
    ))
    .map_err(|e| format!("serialize bd working directory: {e}"))
}

pub fn resolve_stop_message_followup_provider_key_json(input_json: &str) -> Result<String, String> {
    let input: persisted_lookup::ServertoolRecordRuntimeMetadataInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message followup provider key input: {e}"))?;
    serde_json::to_string(&persisted_lookup::resolve_stop_message_followup_provider_key(&input))
        .map_err(|e| format!("serialize stop-message followup provider key: {e}"))
}

pub fn get_captured_request_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize captured request input: {e}"))?;
    serde_json::to_string(&persisted_lookup::get_captured_request(&input))
        .map_err(|e| format!("serialize captured request: {e}"))
}

pub fn resolve_client_connection_state_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize client connection state input: {e}"))?;
    serde_json::to_string(&persisted_lookup::resolve_client_connection_state(&input))
        .map_err(|e| format!("serialize client connection state: {e}"))
}

pub fn has_compaction_flag_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize compaction flag input: {e}"))?;
    Ok(if persisted_lookup::has_compaction_flag(&input) {
        "true"
    } else {
        "false"
    }
    .to_string())
}

pub fn resolve_entry_endpoint_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize entry endpoint input: {e}"))?;
    serde_json::to_string(&persisted_lookup::resolve_entry_endpoint(&input))
        .map_err(|e| format!("serialize entry endpoint: {e}"))
}

pub fn resolve_stop_message_followup_tool_content_max_chars_json(
    input_json: &str,
) -> Result<String, String> {
    let input: persisted_lookup::StopMessageFollowupToolContentMaxCharsInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize stop-message followup tool content max chars input: {e}")
        })?;
    serde_json::to_string(
        &persisted_lookup::resolve_stop_message_followup_tool_content_max_chars(&input),
    )
    .map_err(|e| format!("serialize stop-message followup tool content max chars: {e}"))
}

pub fn plan_persist_stop_message_state_json(input_json: &str) -> Result<String, String> {
    let input: persisted_lookup::PersistStopMessageStatePlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize persist stop-message state input: {e}"))?;
    let plan = persisted_lookup::plan_persist_stop_message_state(&input)?;
    serde_json::to_string(&plan)
        .map_err(|e| format!("serialize persist stop-message state plan: {e}"))
}

pub fn resolve_pending_session_file_name_json(input_json: &str) -> Result<String, String> {
    let input: pending_session_contract::PendingSessionFileInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize pending session file input: {e}"))?;
    serde_json::to_string(&pending_session_contract::resolve_pending_file_name(&input))
        .map_err(|e| format!("serialize pending session file name: {e}"))
}

pub fn resolve_pending_session_max_age_ms_json(input_json: &str) -> Result<String, String> {
    let input: pending_session_contract::PendingSessionMaxAgeInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize pending session max-age input: {e}"))?;
    serde_json::to_string(&pending_session_contract::resolve_pending_max_age_ms(
        &input,
    ))
    .map_err(|e| format!("serialize pending session max-age: {e}"))
}

pub fn plan_pending_session_save_json(input_json: &str) -> Result<String, String> {
    let input: pending_session_contract::PendingSessionSaveInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize pending session save input: {e}"))?;
    serde_json::to_string(&pending_session_contract::plan_pending_session_save(input))
        .map_err(|e| format!("serialize pending session save plan: {e}"))
}

pub fn plan_pending_session_load_json(input_json: &str) -> Result<String, String> {
    let input: pending_session_contract::PendingSessionLoadInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize pending session load input: {e}"))?;
    serde_json::to_string(&pending_session_contract::plan_pending_session_load(input))
        .map_err(|e| format!("serialize pending session load plan: {e}"))
}

pub fn plan_pending_injection_persist_json(input_json: &str) -> Result<String, String> {
    let input: pending_session_contract::PendingInjectionPersistInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize pending injection persist input: {e}"))?;
    let plan = pending_session_contract::plan_pending_injection_persist(input)?;
    serde_json::to_string(&plan).map_err(|e| format!("serialize pending injection plan: {e}"))
}

pub fn plan_pending_injection_persist_error_json(input_json: &str) -> Result<String, String> {
    let input: pending_session_contract::PendingInjectionPersistErrorInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize pending injection persist error input: {e}"))?;
    serde_json::to_string(&pending_session_contract::plan_pending_injection_persist_error(input))
        .map_err(|e| format!("serialize pending injection error plan: {e}"))
}

pub fn plan_pre_command_hooks_config_json(input_json: &str) -> Result<String, String> {
    let input: pre_command_hook_contract::PreCommandHooksConfigPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize pre-command hooks config input: {e}"))?;
    serde_json::to_string(&pre_command_hook_contract::plan_pre_command_hooks_config(
        &input,
    ))
    .map_err(|e| format!("serialize pre-command hooks config plan: {e}"))
}

pub fn plan_runtime_pre_command_rule_json(input_json: &str) -> Result<String, String> {
    let input: pre_command_hook_contract::RuntimePreCommandRulePlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize runtime pre-command rule input: {e}"))?;
    serde_json::to_string(&pre_command_hook_contract::plan_runtime_pre_command_rule(
        &input,
    ))
    .map_err(|e| format!("serialize runtime pre-command rule plan: {e}"))
}

pub fn plan_engine_selection_start_json(input_json: &str) -> Result<String, String> {
    let input: engine_selection_contract::EngineSelectionStartInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize engine selection start input: {e}"))?;
    serde_json::to_string(&engine_selection_contract::plan_engine_selection_start(
        input,
    ))
    .map_err(|e| format!("serialize engine selection start plan: {e}"))
}

pub fn plan_engine_selection_after_run_json(input_json: &str) -> Result<String, String> {
    let input: engine_selection_contract::EngineSelectionAfterRunInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize engine selection after-run input: {e}"))?;
    serde_json::to_string(&engine_selection_contract::plan_engine_selection_after_run(
        input,
    ))
    .map_err(|e| format!("serialize engine selection after-run plan: {e}"))
}

pub fn resolve_default_stop_message_snapshot_json(input_json: &str) -> Result<String, String> {
    let input: persisted_lookup::StopMessageDefaultSnapshotInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize default stop-message snapshot input: {e}"))?;
    let snapshot = persisted_lookup::resolve_default_stop_message_snapshot(&input);
    serde_json::to_string(&snapshot)
        .map_err(|e| format!("serialize default stop-message snapshot: {e}"))
}

pub fn resolve_implicit_gemini_stop_message_snapshot_json(
    input_json: &str,
) -> Result<String, String> {
    let input: persisted_lookup::StopMessageImplicitGeminiSnapshotInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize implicit Gemini stop-message snapshot input: {e}"))?;
    let snapshot = persisted_lookup::resolve_implicit_gemini_stop_message_snapshot(&input);
    serde_json::to_string(&snapshot)
        .map_err(|e| format!("serialize implicit Gemini stop-message snapshot: {e}"))
}

pub fn read_servertool_loop_state_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool loop state input: {e}"))?;
    let snapshot = loop_state_contract::read_servertool_loop_state(&input);
    serde_json::to_string(&snapshot).map_err(|e| format!("serialize servertool loop state: {e}"))
}

pub fn plan_servertool_loop_state_json(input_json: &str) -> Result<String, String> {
    let input: loop_state_contract::ServertoolLoopStatePlanInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool loop state plan input: {e}"))?;
    let snapshot = loop_state_contract::plan_servertool_loop_state(input);
    serde_json::to_string(&snapshot)
        .map_err(|e| format!("serialize servertool loop state plan: {e}"))
}

pub fn parse_servertool_timeout_ms_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolTimeoutPolicyInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool timeout input: {e}"))?;
    serde_json::to_string(&orchestration_policy_contract::parse_servertool_timeout_ms(
        &input,
    )?)
    .map_err(|e| format!("serialize servertool timeout: {e}"))
}

pub fn plan_servertool_timeout_watcher_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolTimeoutWatcherInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool timeout watcher input: {e}"))?;
    serde_json::to_string(&orchestration_policy_contract::plan_servertool_timeout_watcher(&input))
        .map_err(|e| format!("serialize servertool timeout watcher: {e}"))
}

pub fn is_adapter_client_disconnected_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize adapter client disconnect input: {e}"))?;
    Ok(
        if orchestration_policy_contract::is_adapter_client_disconnected(&input) {
            "true"
        } else {
            "false"
        }
        .to_string(),
    )
}

pub fn plan_client_disconnect_watcher_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolClientDisconnectWatcherInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize client disconnect watcher input: {e}"))?;
    serde_json::to_string(&orchestration_policy_contract::plan_client_disconnect_watcher(&input))
        .map_err(|e| format!("serialize client disconnect watcher: {e}"))
}

pub fn plan_servertool_client_disconnected_error_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolClientDisconnectedErrorInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool client disconnected error input: {e}"))?;
    serde_json::to_string(
        &orchestration_policy_contract::plan_servertool_client_disconnected_error(&input),
    )
    .map_err(|e| format!("serialize servertool client disconnected error: {e}"))
}

pub fn plan_servertool_timeout_error_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolTimeoutErrorInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool timeout error input: {e}"))?;
    serde_json::to_string(&orchestration_policy_contract::plan_servertool_timeout_error(&input)?)
        .map_err(|e| format!("serialize servertool timeout error: {e}"))
}

pub fn plan_stop_message_fetch_failed_error_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::StopMessageFetchFailedErrorInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message fetch failed error input: {e}"))?;
    serde_json::to_string(
        &orchestration_policy_contract::plan_stop_message_fetch_failed_error(&input)?,
    )
    .map_err(|e| format!("serialize stop-message fetch failed error: {e}"))
}

pub fn read_client_inject_only_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize client inject metadata input: {e}"))?;
    Ok(
        if orchestration_policy_contract::read_client_inject_only(&input) {
            "true"
        } else {
            "false"
        }
        .to_string(),
    )
}

pub fn normalize_client_inject_text_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolClientInjectTextInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize client inject text input: {e}"))?;
    serde_json::to_string(&orchestration_policy_contract::normalize_client_inject_text(&input)?)
        .map_err(|e| format!("serialize client inject text: {e}"))
}

pub fn compact_followup_error_reason_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize followup error reason input: {e}"))?;
    serde_json::to_string(&orchestration_policy_contract::compact_followup_error_reason(&input))
        .map_err(|e| format!("serialize followup error reason: {e}"))
}

pub fn resolve_adapter_context_provider_key_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolProviderKeyInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize adapter provider key input: {e}"))?;
    serde_json::to_string(
        &orchestration_policy_contract::resolve_adapter_context_provider_key(&input),
    )
    .map_err(|e| format!("serialize adapter provider key: {e}"))
}

pub fn build_client_exec_cli_projection_output_json(input_json: &str) -> Result<String, String> {
    let input: cli_contract::ClientExecCliProjectionInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize projection input: {e}"))?;
    let output =
        cli_contract::plan_client_exec_cli_projection_output(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize projection output: {e}"))
}

pub fn plan_stop_message_cli_projection_seed_json(input_json: &str) -> Result<String, String> {
    let input: cli_contract::StopMessageCliProjectionSeedInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message cli projection seed input: {e}"))?;
    let output =
        cli_contract::plan_stop_message_cli_projection_seed(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output)
        .map_err(|e| format!("serialize stop-message cli projection seed: {e}"))
}

pub fn plan_stopless_orchestration_action_json(input_json: &str) -> Result<String, String> {
    let input: stopless_orchestration_contract::StoplessOrchestrationPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stopless orchestration input: {e}"))?;
    serde_json::to_string(
        &stopless_orchestration_contract::plan_stopless_orchestration_action(input),
    )
    .map_err(|e| format!("serialize stopless orchestration plan: {e}"))
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

pub fn plan_servertool_backend_route_policy_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolBackendRoutePolicyInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize backend route input: {e}"))?;
    let output = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(input)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize backend route plan: {e}"))
}

pub fn plan_vision_eligibility_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolVisionEligibilityInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize vision eligibility input: {e}"))?;
    let output = plan_vision_eligibility(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize vision eligibility plan: {e}"))
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

pub fn plan_followup_materialization_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolFollowupMaterializationInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize followup materialization input: {e}"))?;
    let output = plan_followup_materialization(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize materialization plan: {e}"))
}

pub fn plan_followup_error_envelope_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolFollowupErrorPlanInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize followup error envelope input: {e}"))?;
    let output = plan_followup_error_envelope(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize followup error envelope: {e}"))
}

pub fn plan_bootstrap_replay_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolBootstrapReplayPlanInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize bootstrap replay input: {e}"))?;
    let output = plan_bootstrap_replay(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize bootstrap replay plan: {e}"))
}

pub fn extract_text_from_chat_like_json(input_json: &str) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize text extraction payload: {e}"))?;
    let text = text_extraction::extract_text_from_chat_like(&payload);
    serde_json::to_string(&text).map_err(|e| format!("serialize extracted text: {e}"))
}

pub fn extract_current_assistant_stop_text_json(input_json: &str) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize current assistant stop text payload: {e}"))?;
    let text = stop_visible_text::extract_current_assistant_stop_text(&payload);
    serde_json::to_string(&text).map_err(|e| format!("serialize current assistant stop text: {e}"))
}

pub fn strip_stop_schema_control_text_json(input_json: &str) -> Result<String, String> {
    let text: String = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize stop schema text input: {e}"))?;
    let stripped = stop_visible_text::strip_stop_schema_control_text(&text);
    serde_json::to_string(&stripped).map_err(|e| format!("serialize stripped text: {e}"))
}

pub fn build_stop_message_terminal_visible_payload_json(
    input_json: &str,
) -> Result<String, String> {
    let input: stop_visible_text::StopMessageTerminalVisiblePayloadInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize terminal visible payload input: {e}"))?;
    let output = stop_visible_text::build_stop_message_terminal_visible_payload(input);
    serde_json::to_string(&output).map_err(|e| format!("serialize terminal visible payload: {e}"))
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
    fn normalizes_stop_gateway_context_via_servertool_core_bridge() {
        let raw = normalize_stop_gateway_context_json(
            &json!({
                "observed": true,
                "eligible": false,
                "source": " CHAT ",
                "reason": " finish_reason_stop ",
                "choiceIndex": 2.8,
                "hasToolCalls": true
            })
            .to_string(),
        )
        .expect("stop gateway context bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["observed"], true);
        assert_eq!(parsed["eligible"], false);
        assert_eq!(parsed["source"], "chat");
        assert_eq!(parsed["reason"], "finish_reason_stop");
        assert_eq!(parsed["choice_index"], 2);
        assert_eq!(parsed["has_tool_calls"], true);
    }

    #[test]
    fn normalizes_stop_message_compare_context_via_servertool_core_bridge() {
        let raw = normalize_stop_message_compare_context_json(
            &json!({
                "armed": true,
                "mode": " AUTO ",
                "allowModeOnly": false,
                "textLength": 12.8,
                "maxRepeats": 3.2,
                "used": 1.9,
                "active": true,
                "stopEligible": true,
                "hasCapturedRequest": true,
                "compactionRequest": false,
                "hasSeed": true,
                "decision": " TRIGGER ",
                "reason": " native_decision ",
                "observationStableCount": 2.7
            })
            .to_string(),
        )
        .expect("stop-message compare context bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["mode"], "auto");
        assert_eq!(parsed["decision"], "trigger");
        assert_eq!(parsed["textLength"], 12);
        assert_eq!(parsed["maxRepeats"], 3);
        assert_eq!(parsed["used"], 1);
        assert_eq!(parsed["remaining"], 2);
        assert_eq!(parsed["observationStableCount"], 2);

        let summary = format_stop_message_compare_context_json(&raw).expect("summary");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&summary).expect("json"),
            json!("decision=trigger reason=native_decision armed=true mode=auto allowModeOnly=false max=3 used=1 left=2 active=true stopEligible=true captured=true compaction=false seed=true obs=none stable=2 toolSig=none")
        );
    }

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
    fn plans_vision_eligibility_via_servertool_core_bridge() {
        let raw = plan_vision_eligibility_json(
            &json!({
                "adapterContext": {
                    "providerProtocol": "openai-chat",
                    "routeHint": "default",
                    "capturedChatRequest": {
                        "messages": [{
                            "role": "user",
                            "content": [
                                { "type": "text", "text": "describe" },
                                { "type": "image_url", "image_url": { "url": "https://example.com/a.png" } }
                            ]
                        }]
                    }
                }
            })
            .to_string(),
        )
        .expect("vision eligibility");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["shouldRunVisionFlow"], true);
        assert_eq!(parsed["shouldBypassStopMessage"], true);
        assert_eq!(parsed["reason"], "image_attachment");
    }

    #[test]
    fn plans_orchestration_policy_via_servertool_core_bridge() {
        let timeout = parse_servertool_timeout_ms_json(&json!({ "raw": "1200.8" }).to_string())
            .expect("timeout");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&timeout).expect("json"),
            json!(1200)
        );
        let timeout_watcher =
            plan_servertool_timeout_watcher_json(&json!({ "timeoutMs": "50.8" }).to_string())
                .expect("timeout watcher");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&timeout_watcher).expect("json"),
            json!({ "armed": true, "timeoutMs": 50 })
        );
        let disconnected = is_adapter_client_disconnected_json(
            &json!({ "clientConnectionState": { "disconnected": " true " } }).to_string(),
        )
        .expect("disconnected");
        assert_eq!(disconnected, "true");
        let disconnect_watcher =
            plan_client_disconnect_watcher_json(&json!({ "pollIntervalMs": 1 }).to_string())
                .expect("disconnect watcher");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&disconnect_watcher).expect("json"),
            json!({ "intervalMs": 20 })
        );
        let disconnected_error = plan_servertool_client_disconnected_error_json(
            &json!({ "requestId": " req-1 ", "flowId": " flow-1 " }).to_string(),
        )
        .expect("disconnected error");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&disconnected_error).expect("json"),
            json!({
                "message": "[servertool] client disconnected during followup flow=flow-1",
                "code": "SERVERTOOL_CLIENT_DISCONNECTED",
                "category": "INTERNAL_ERROR",
                "status": 499,
                "details": { "requestId": "req-1", "flowId": "flow-1" }
            })
        );
        let timeout_error = plan_servertool_timeout_error_json(
            &json!({
                "requestId": "req-2",
                "phase": "followup",
                "timeoutMs": 1000.8,
                "attempt": 2.1
            })
            .to_string(),
        )
        .expect("timeout error");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&timeout_error).expect("json"),
            json!({
                "message": "[servertool] followup timeout after 1000ms",
                "code": "SERVERTOOL_TIMEOUT",
                "category": "INTERNAL_ERROR",
                "status": 504,
                "details": { "requestId": "req-2", "phase": "followup", "timeoutMs": 1000, "attempt": 2 }
            })
        );
        let fetch_failed = plan_stop_message_fetch_failed_error_json(
            &json!({
                "requestId": "req-3",
                "reason": "loop_limit",
                "elapsedMs": -1,
                "attempt": 0
            })
            .to_string(),
        )
        .expect("fetch failed");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fetch_failed).expect("json"),
            json!({
                "message": "fetch failed: network error (stopMessage loop detected)",
                "code": "SERVERTOOL_TIMEOUT",
                "category": "EXTERNAL_ERROR",
                "status": 502,
                "details": { "requestId": "req-3", "reason": "loop_limit", "elapsedMs": 0, "attempt": 1 }
            })
        );
        let client_inject =
            read_client_inject_only_json(&json!({ "clientInjectOnly": " true " }).to_string())
                .expect("client inject");
        assert_eq!(client_inject, "true");
        let text = normalize_client_inject_text_json(
            &json!({ "value": " hello\n[Time/Date]: now\n<**hidden**>\nworld " }).to_string(),
        )
        .expect("client inject text");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).expect("json"),
            json!("hello\n\nworld")
        );
        let reason =
            compact_followup_error_reason_json(&json!("HTTP 503: unavailable").to_string())
                .expect("reason");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&reason).expect("json"),
            json!("HTTP_503")
        );
        let provider_key = resolve_adapter_context_provider_key_json(
            &json!({
                "adapterContext": {
                    "providerKey": "alias",
                    "targetProviderKey": "direct",
                    "target": { "providerKey": "exact" }
                }
            })
            .to_string(),
        )
        .expect("provider key");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&provider_key).expect("json"),
            json!("exact")
        );
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
    fn plans_followup_materialization_via_servertool_core_bridge() {
        let raw = plan_followup_materialization_json(
            &json!({
                "followupPlan": {
                    "entryEndpoint": " /v1/responses ",
                    "injection": {
                        "ops": [{ "op": "append_user_text", "text": "next" }]
                    }
                },
                "entryEndpoint": "/v1/chat/completions"
            })
            .to_string(),
        )
        .expect("materialization bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["entryEndpoint"], "/v1/responses");
        assert_eq!(parsed["payloadSource"], "injection");
        assert!(parsed["payload"].is_null());
        assert!(parsed["injection"]["ops"].is_array());
    }

    #[test]
    fn plans_followup_error_envelope_via_servertool_core_bridge() {
        let raw = plan_followup_error_envelope_json(
            &json!({
                "error": {
                    "details": {
                        "statusCode": 429.9,
                        "upstreamCode": "HTTP_429",
                        "reason": "rate limit"
                    }
                }
            })
            .to_string(),
        )
        .expect("followup error envelope bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["upstreamStatus"], 429);
        assert_eq!(parsed["upstreamCode"], "HTTP_429");
        assert_eq!(parsed["reason"], "rate limit");
        assert_eq!(parsed["terminal"], true);
    }

    #[test]
    fn plans_bootstrap_replay_via_servertool_core_bridge() {
        let raw = plan_bootstrap_replay_json(
            &json!({
                "preflightBody": { "ok": true },
                "replaySeed": {
                    "model": "gpt-test",
                    "messages": [{ "role": "user", "content": "hello" }],
                    "parameters": { "temperature": 0.1 }
                },
                "adapterContext": null
            })
            .to_string(),
        )
        .expect("bootstrap replay bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert!(parsed["preflightFailure"].is_null());
        assert_eq!(parsed["replayPayload"]["model"], "gpt-test");
        assert_eq!(parsed["replayPayload"]["messages"][0]["role"], "user");
        assert_eq!(parsed["replayPayload"]["parameters"]["temperature"], 0.1);
    }

    #[test]
    fn plans_bootstrap_replay_from_adapter_context_seed_via_servertool_core_bridge() {
        let raw = plan_bootstrap_replay_json(
            &json!({
                "preflightBody": { "ok": true },
                "replaySeed": null,
                "adapterContext": {
                    "capturedChatRequest": {
                        "model": "gpt-adapter",
                        "messages": [{ "role": "user", "content": "hello from adapter" }],
                        "parameters": { "temperature": 0.3 }
                    }
                }
            })
            .to_string(),
        )
        .expect("bootstrap replay bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert!(parsed["preflightFailure"].is_null());
        assert_eq!(parsed["replayPayload"]["model"], "gpt-adapter");
        assert_eq!(
            parsed["replayPayload"]["messages"][0]["content"],
            "hello from adapter"
        );
        assert_eq!(parsed["replayPayload"]["parameters"]["temperature"], 0.3);
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
    fn strips_stop_schema_control_text_via_servertool_core_bridge() {
        let raw = strip_stop_schema_control_text_json(
            &json!("visible\n<stop_schema>{\"stopreason\":\"blocked\"}</stop_schema>\n停止原因：blocked")
                .to_string(),
        )
        .expect("strip text");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, json!("visible"));
    }

    #[test]
    fn builds_terminal_visible_payload_via_servertool_core_bridge() {
        let raw = build_stop_message_terminal_visible_payload_json(
            &json!({
                "payload": {
                    "choices": [{
                        "message": {
                            "content": "answer {\"stopreason\":\"blocked\",\"next_step\":\"inspect\"}",
                            "reasoning_text": "private"
                        }
                    }]
                },
                "mode": "strip"
            })
            .to_string(),
        )
        .expect("terminal payload");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(
            parsed["payload"]["choices"][0]["message"]["content"],
            "answer"
        );
        assert!(parsed["payload"]["choices"][0]["message"]
            .get("reasoning_text")
            .is_none());
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

    #[test]
    fn resolves_default_stop_message_snapshot_via_servertool_core_bridge() {
        let raw = resolve_default_stop_message_snapshot_json(
            &json!({
                "base": {
                    "choices": [{
                        "finish_reason": "stop",
                        "message": { "role": "assistant", "content": "done" }
                    }]
                },
                "adapterContext": null,
                "options": {
                    "text": " keep going ",
                    "maxRepeats": 2.9
                }
            })
            .to_string(),
        )
        .expect("default snapshot bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["text"], "keep going");
        assert_eq!(parsed["maxRepeats"], 2);
        assert_eq!(parsed["used"], 0);
        assert_eq!(parsed["source"], "default");
    }

    #[test]
    fn resolves_implicit_gemini_stop_message_snapshot_via_servertool_core_bridge() {
        let raw = resolve_implicit_gemini_stop_message_snapshot_json(
            &json!({
                "base": {
                    "status": "completed",
                    "output": []
                },
                "adapterContext": {
                    "__rt": {
                        "stopGatewayContext": {
                            "observed": true,
                            "eligible": true,
                            "source": "responses",
                            "reason": "status_completed"
                        }
                    }
                },
                "providerProtocol": "gemini-chat",
                "record": {
                    "entryEndpoint": "/v1/responses"
                }
            })
            .to_string(),
        )
        .expect("implicit gemini snapshot bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["text"], "继续执行");
        assert_eq!(parsed["maxRepeats"], 1);
        assert_eq!(parsed["source"], "auto");
    }

    #[test]
    fn reads_servertool_loop_state_via_servertool_core_bridge() {
        let raw = read_servertool_loop_state_json(
            &json!({
                "serverToolLoopState": {
                    "flowId": " stop_message_flow ",
                    "payloadHash": " __servertool_auto__ ",
                    "repeatCount": 2.9,
                    "startedAtMs": 100,
                    "stopPairHash": " pair-a ",
                    "stopPairRepeatCount": 4.1,
                    "stopPairWarned": true
                }
            })
            .to_string(),
        )
        .expect("loop state bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["flowId"], "stop_message_flow");
        assert_eq!(parsed["payloadHash"], "__servertool_auto__");
        assert_eq!(parsed["repeatCount"], 2);
        assert_eq!(parsed["stopPairRepeatCount"], 4);
        assert_eq!(parsed["stopPairWarned"], true);
    }

    #[test]
    fn plans_servertool_loop_state_via_servertool_core_bridge() {
        let raw = plan_servertool_loop_state_json(
            &json!({
                "flowId": "stop_message_flow",
                "decision": { "flowOnlyLoopLimit": false },
                "previousLoopState": {
                    "flowId": "stop_message_flow",
                    "payloadHash": "__servertool_auto__",
                    "repeatCount": 2,
                    "startedAtMs": 100,
                    "stopPairHash": "pair-a",
                    "stopPairRepeatCount": 4,
                    "stopPairWarned": true
                },
                "payloadHash": "ignored",
                "stopPairHash": "pair-a",
                "nowMs": 200
            })
            .to_string(),
        )
        .expect("loop state plan bridge");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["flowId"], "stop_message_flow");
        assert_eq!(parsed["payloadHash"], "__servertool_auto__");
        assert_eq!(parsed["repeatCount"], 3);
        assert_eq!(parsed["startedAtMs"], 100);
        assert_eq!(parsed["stopPairRepeatCount"], 5);
        assert_eq!(parsed["stopPairWarned"], true);
    }

    #[test]
    fn resolves_servertool_state_key_via_servertool_core_bridge() {
        let raw = resolve_servertool_state_key_json(
            &json!({
                "continuation": {
                    "stickyScope": "request_chain",
                    "resumeFrom": { "requestId": "req-parent" }
                },
                "clientTmuxSessionId": "tmux-a",
                "requestId": "req-child"
            })
            .to_string(),
        )
        .expect("state key");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, json!("req-parent"));
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
        assert!(parsed.get("repeatCount").is_none());
    }

    #[test]
    fn resolves_runtime_stop_message_state_from_adapter_context_via_servertool_core_bridge() {
        let command = "routecodex servertool run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"continue from command\",\"repeatCount\":1,\"maxRepeats\":3}'";
        let raw = resolve_runtime_stop_message_state_from_adapter_context_json(
            &json!({
                "adapterContext": {
                    "__raw_request_body": {
                        "input": [{
                            "type": "function_call",
                            "call_id": "call_servertool_cli",
                            "name": "exec_command",
                            "arguments": json!({ "cmd": command }).to_string()
                        }],
                        "tool_outputs": [{
                            "type": "function_call_output",
                            "call_id": "call_servertool_cli",
                            "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"continue from output\",\"repeatCount\":2,\"maxRepeats\":4}"
                        }]
                    }
                },
                "runtimeMetadata": null
            })
            .to_string(),
        )
        .expect("runtime stop state from adapter context");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["text"], "continue from output");
        assert_eq!(parsed["maxRepeats"], 4);
        assert_eq!(parsed["used"], 2);
        assert_eq!(parsed["source"], "client_exec_result");
        assert_eq!(parsed["stageMode"], "on");
    }

    #[test]
    fn reads_runtime_stop_stage_mode_via_servertool_core_bridge() {
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
        assert_eq!(parsed, json!("auto"));
    }

    #[test]
    fn reads_servertool_followup_flow_id_via_servertool_core_bridge() {
        let raw = read_servertool_followup_flow_id_json(
            &json!({
                "serverToolLoopState": {
                    "flowId": " stop_message_flow "
                }
            })
            .to_string(),
        )
        .expect("followup flow id");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, json!("stop_message_flow"));
    }

    #[test]
    fn resolves_bd_working_directory_via_servertool_core_bridge() {
        let raw = resolve_bd_working_directory_for_record_json(
            &json!({
                "record": {
                    "metadata": {
                        "capturedContext": {
                            "__hub_capture": {
                                "context": { "workdir": " /repo/captured " }
                            }
                        }
                    }
                },
                "runtimeMetadata": { "workdir": "/repo/runtime" }
            })
            .to_string(),
        )
        .expect("bd working directory");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, json!("/repo/captured"));
    }

    #[test]
    fn resolves_stop_message_followup_provider_key_via_servertool_core_bridge() {
        let raw = resolve_stop_message_followup_provider_key_json(
            &json!({
                "record": {
                    "metadata": {
                        "target": { "providerId": " target.provider " }
                    }
                },
                "runtimeMetadata": { "providerKey": "runtime.provider" }
            })
            .to_string(),
        )
        .expect("provider key");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed, json!("target.provider"));
    }

    #[test]
    fn resolves_runtime_context_helpers_via_servertool_core_bridge() {
        let captured = get_captured_request_json(
            &json!({
                "capturedEntryRequest": { "input": "entry" },
                "capturedChatRequest": { "messages": [] }
            })
            .to_string(),
        )
        .expect("captured request");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&captured).expect("json"),
            json!({ "input": "entry" })
        );

        let connection =
            resolve_client_connection_state_json(&json!({ "disconnected": true }).to_string())
                .expect("connection");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&connection).expect("json"),
            json!({ "disconnected": true })
        );

        assert_eq!(
            has_compaction_flag_json(&json!({ "compactionRequest": " true " }).to_string())
                .expect("compaction flag"),
            "true"
        );

        let endpoint = resolve_entry_endpoint_json(
            &json!({ "metadata": { "entryEndpoint": " /v1/responses " } }).to_string(),
        )
        .expect("entry endpoint");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&endpoint).expect("json"),
            json!("/v1/responses")
        );
    }

    #[test]
    fn resolves_followup_tool_content_max_chars_via_servertool_core_bridge() {
        let raw = resolve_stop_message_followup_tool_content_max_chars_json(
            &json!({
                "envValue": " 2000.9 ",
                "model": "kimi-k2.5"
            })
            .to_string(),
        )
        .expect("tool content max chars");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&raw).expect("json"),
            json!(2000)
        );

        let fallback = resolve_stop_message_followup_tool_content_max_chars_json(
            &json!({
                "model": " KIMI-K2.5-preview "
            })
            .to_string(),
        )
        .expect("tool content max chars fallback");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fallback).expect("json"),
            json!(1200)
        );
    }

    #[test]
    fn plans_persist_stop_message_state_via_servertool_core_bridge() {
        let raw = plan_persist_stop_message_state_json(
            &json!({
                "state": {
                    "allowedProviders": [],
                    "disabledProviders": [],
                    "disabledKeys": [],
                    "disabledModels": [],
                    "stopMessageText": " "
                }
            })
            .to_string(),
        )
        .expect("persist plan");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&raw).expect("json"),
            json!({ "action": "clear" })
        );

        let save = plan_persist_stop_message_state_json(
            &json!({
                "state": {
                    "allowedProviders": [],
                    "disabledProviders": [],
                    "disabledKeys": [{ "provider": "p", "keys": [] }],
                    "disabledModels": []
                }
            })
            .to_string(),
        )
        .expect("persist save plan");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&save).expect("json"),
            json!({ "action": "save" })
        );
    }

    #[test]
    fn plans_pending_session_via_servertool_core_bridge() {
        let file_name = resolve_pending_session_file_name_json(
            &json!({ "sessionId": " bad/session id " }).to_string(),
        )
        .expect("file name");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&file_name).expect("json"),
            json!("bad_session_id.json")
        );

        let max_age =
            resolve_pending_session_max_age_ms_json(&json!({ "raw": "1500" }).to_string())
                .expect("max age");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&max_age).expect("json"),
            json!(1500)
        );

        let save = plan_pending_session_save_json(
            &json!({
                "sessionId": "sess-1",
                "pending": {
                    "createdAtMs": 1000,
                    "afterToolCallIds": [" call-1 "],
                    "messages": [{ "role": "assistant" }]
                }
            })
            .to_string(),
        )
        .expect("save plan");
        let save_plan: serde_json::Value = serde_json::from_str(&save).expect("save json");
        assert_eq!(save_plan["fileName"], "sess-1.json");
        assert_eq!(save_plan["payload"]["sessionId"], "sess-1");

        let load = plan_pending_session_load_json(
            &json!({
                "raw": save_plan["payload"],
                "nowMs": 1100,
                "maxAgeMs": 1000
            })
            .to_string(),
        )
        .expect("load plan");
        let load_plan: serde_json::Value = serde_json::from_str(&load).expect("load json");
        assert_eq!(load_plan["action"], "use");
        assert_eq!(load_plan["pending"]["afterToolCallIds"], json!(["call-1"]));

        let persist = plan_pending_injection_persist_json(
            &json!({
                "pendingInjection": {
                    "sessionId": " sess-1 ",
                    "aliasSessionIds": ["sess-2", "sess-1"],
                    "afterToolCallIds": [" call-2 "],
                    "messages": [{ "role": "assistant" }]
                },
                "requestId": " req-1 ",
                "flowId": " flow-1 ",
                "createdAtMs": 2000
            })
            .to_string(),
        )
        .expect("persist injection plan");
        let persist_plan: serde_json::Value =
            serde_json::from_str(&persist).expect("persist injection json");
        assert_eq!(persist_plan["action"], "persist");
        assert_eq!(persist_plan["sessionIds"], json!(["sess-1", "sess-2"]));
        assert_eq!(
            persist_plan["records"][0]["pending"]["sourceRequestId"],
            "req-1"
        );

        let error = plan_pending_injection_persist_error_json(
            &json!({
                "requestId": "req-1",
                "flowId": "flow-1",
                "sessionIds": ["sess-1"],
                "reason": "disk full"
            })
            .to_string(),
        )
        .expect("persist injection error plan");
        let error_plan: serde_json::Value =
            serde_json::from_str(&error).expect("persist injection error json");
        assert_eq!(error_plan["status"], 502);
        assert_eq!(error_plan["details"]["sessionIds"], json!(["sess-1"]));
    }

    #[test]
    fn plans_pre_command_hooks_via_servertool_core_bridge() {
        let config = plan_pre_command_hooks_config_json(
            &json!({
                "raw": {
                    "enabled": true,
                    "hooks": [
                        { "id": "second hook", "tool": "exec_command", "priority": 20, "jq": ".cmd = .cmd" },
                        { "id": "first-hook", "tools": ["shell"], "priority": 10, "cmdRegex": "/^npm\\s+/g", "shell": "echo ok" }
                    ]
                }
            })
            .to_string(),
        )
        .expect("pre-command config plan");
        let config_plan: serde_json::Value =
            serde_json::from_str(&config).expect("pre-command config json");
        assert_eq!(config_plan["enabled"], true);
        assert_eq!(config_plan["hooks"][0]["id"], "first-hook");
        assert_eq!(config_plan["hooks"][0]["cmdRegex"]["source"], "^npm\\s+");
        assert_eq!(config_plan["hooks"][1]["id"], "second_hook");

        let runtime = plan_runtime_pre_command_rule_json(
            &json!({
                "rawState": { "preCommandScriptPath": "/tmp/rewrite.sh" },
                "envTimeoutMs": "1500",
                "scriptPathAllowed": true
            })
            .to_string(),
        )
        .expect("runtime pre-command plan");
        let runtime_plan: serde_json::Value =
            serde_json::from_str(&runtime).expect("runtime pre-command json");
        assert_eq!(runtime_plan["id"], "runtime_precommand:rewrite.sh");
        assert_eq!(runtime_plan["timeoutMs"], 1500);
        assert_eq!(runtime_plan["runtimeScriptPath"], "/tmp/rewrite.sh");
    }

    #[test]
    fn plans_engine_selection_via_servertool_core_bridge() {
        let start = plan_engine_selection_start_json(
            &json!({
                "primaryAutoHookIds": [" stop_message_auto ", "stop_message_auto", "vision_auto"]
            })
            .to_string(),
        )
        .expect("engine selection start plan");
        let start_plan: serde_json::Value =
            serde_json::from_str(&start).expect("engine selection start json");
        assert_eq!(start_plan["action"], "run_primary_hooks");
        assert_eq!(
            start_plan["overrides"]["includeAutoHookIds"],
            json!(["stop_message_auto", "vision_auto"])
        );
        assert_eq!(start_plan["overrides"]["disableToolCallHandlers"], true);

        let after = plan_engine_selection_after_run_json(
            &json!({
                "primaryAutoHookIds": ["stop_message_auto"],
                "engineResult": { "mode": "passthrough" }
            })
            .to_string(),
        )
        .expect("engine selection after-run plan");
        let after_plan: serde_json::Value =
            serde_json::from_str(&after).expect("engine selection after-run json");
        assert_eq!(after_plan["action"], "rerun_excluding_primary_hooks");
        assert_eq!(
            after_plan["overrides"]["excludeAutoHookIds"],
            json!(["stop_message_auto"])
        );
    }

    #[test]
    fn plans_stop_message_cli_projection_seed_via_servertool_core_bridge() {
        let seed = plan_stop_message_cli_projection_seed_json(
            &json!({
                "execution": {
                    "flowId": "stop_message_flow",
                    "context": {
                        "assistantStopText": "停止原因：remove me\nvisible",
                        "decision": { "followup_text": "continue with tools" }
                    },
                    "followup": {
                        "metadata": {
                            "__rt": {
                                "serverToolLoopState": {
                                    "repeatCount": 1,
                                    "maxRepeats": 3
                                }
                            }
                        }
                    }
                },
                "finalChatResponse": {}
            })
            .to_string(),
        )
        .expect("stop-message cli projection seed");
        let plan: serde_json::Value =
            serde_json::from_str(&seed).expect("stop-message cli projection seed json");
        assert_eq!(plan["flowId"], "stop_message_flow");
        assert_eq!(plan["continuationPrompt"], "continue with tools");
        assert_eq!(plan["reasoningText"], "visible");
        assert_eq!(plan["repeatCount"], 1);
        assert_eq!(plan["maxRepeats"], 3);
        assert_eq!(plan["input"]["continuationPrompt"], "continue with tools");
    }

    #[test]
    fn plans_stopless_orchestration_action_via_servertool_core_bridge() {
        let cli = plan_stopless_orchestration_action_json(
            &json!({
                "flowId": "stop_message_flow",
                "execution": { "flowId": "stop_message_flow" }
            })
            .to_string(),
        )
        .expect("stopless cli action");
        let cli_plan: serde_json::Value =
            serde_json::from_str(&cli).expect("stopless cli action json");
        assert_eq!(cli_plan["action"], "cli_projection");
        assert_eq!(cli_plan["isStopMessageFlow"], true);

        let terminal = plan_stopless_orchestration_action_json(
            &json!({
                "flowId": "stop_message_flow",
                "execution": {
                    "flowId": "stop_message_flow",
                    "context": { "stopMessageTerminalFinal": true }
                }
            })
            .to_string(),
        )
        .expect("stopless terminal action");
        let terminal_plan: serde_json::Value =
            serde_json::from_str(&terminal).expect("stopless terminal action json");
        assert_eq!(terminal_plan["action"], "terminal_final");

        let followup = plan_stopless_orchestration_action_json(
            &json!({
                "flowId": "vision_flow",
                "execution": { "flowId": "vision_flow" }
            })
            .to_string(),
        )
        .expect("stopless followup action");
        let followup_plan: serde_json::Value =
            serde_json::from_str(&followup).expect("stopless followup action json");
        assert_eq!(followup_plan["action"], "followup_mainline");
        assert_eq!(followup_plan["isStopMessageFlow"], false);
    }

    #[test]
    fn plans_stopless_goal_state_sync_via_servertool_core_bridge() {
        let output = plan_stopless_goal_state_sync_json(
            &json!({
                "latestUserText": "前文\n<**rcc**>\nstopless start\n实现统一 RCC stopless\n</rcc**>\n后文",
                "currentState": null,
                "nowMs": 100
            })
            .to_string(),
        )
        .expect("stopless goal state sync plan");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("stopless goal state json");
        assert_eq!(plan["hadDirective"], true);
        assert_eq!(plan["directiveTypes"], json!(["stopless.start"]));
        assert_eq!(plan["rewrittenText"], "前文\n实现统一 RCC stopless\n后文");
        assert_eq!(plan["nextState"]["status"], "active");
        assert_eq!(plan["nextState"]["objective"], "实现统一 RCC stopless");
    }

    #[test]
    fn plans_stop_message_routing_state_via_servertool_core_bridge() {
        let snapshot = plan_stop_message_routing_snapshot_json(
            &json!({
                "raw": {
                    "stopMessageText": " continue ",
                    "stopMessageStageMode": "auto"
                }
            })
            .to_string(),
        )
        .expect("routing snapshot");
        let snapshot_plan: serde_json::Value =
            serde_json::from_str(&snapshot).expect("routing snapshot json");
        assert_eq!(snapshot_plan["text"], "continue");
        assert_eq!(snapshot_plan["maxRepeats"], 10);

        let apply = plan_stop_message_routing_state_apply_json(
            &json!({
                "snapshot": {
                    "text": " continue ",
                    "maxRepeats": 3,
                    "used": 1,
                    "source": " persisted ",
                    "stageMode": "on",
                    "aiMode": "off"
                }
            })
            .to_string(),
        )
        .expect("routing apply");
        let apply_plan: serde_json::Value =
            serde_json::from_str(&apply).expect("routing apply json");
        assert_eq!(apply_plan["source"], "persisted");
        assert_eq!(apply_plan["aiMode"], "off");

        let clear =
            plan_stop_message_routing_state_clear_json(&json!({ "now": 123.9 }).to_string())
                .expect("routing clear");
        let clear_plan: serde_json::Value =
            serde_json::from_str(&clear).expect("routing clear json");
        assert_eq!(clear_plan["timestamp"], 123);
    }

    #[test]
    fn plans_persisted_stop_message_state_selection_via_servertool_core_bridge() {
        let output = plan_stop_message_persisted_state_selection_json(
            &json!({
                "states": [
                    {
                        "key": "tmux:cleared",
                        "state": {
                            "stopMessageLastUsedAt": 123,
                            "stopMessageStageMode": "on"
                        }
                    }
                ]
            })
            .to_string(),
        )
        .expect("persisted state selection plan");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("persisted state selection json");
        assert_eq!(plan["tombstone"]["cleared"], true);
        assert!(plan.get("stageMode").is_none());
        assert!(plan.get("snapshot").is_none());

        let output = plan_stop_message_persisted_state_selection_json(
            &json!({
                "states": [
                    {
                        "key": "tmux:default-exhausted",
                        "state": {
                            "stopMessageText": "default",
                            "stopMessageMaxRepeats": 1,
                            "stopMessageUsed": 1,
                            "stopMessageSource": "default",
                            "stopMessageStageMode": "auto"
                        }
                    },
                    {
                        "key": "session:active",
                        "state": {
                            "stopMessageText": "continue",
                            "stopMessageMaxRepeats": 3,
                            "stopMessageUsed": 2,
                            "stopMessageSource": "explicit",
                            "stopMessageStageMode": "on"
                        }
                    }
                ]
            })
            .to_string(),
        )
        .expect("persisted state selection plan");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("persisted state selection json");
        assert_eq!(plan["snapshot"]["text"], "continue");
        assert_eq!(plan["stageMode"], "auto");
        assert_eq!(plan["tombstone"]["exhaustedDefault"], true);
    }

    #[test]
    fn plans_stopless_decision_context_signals_via_servertool_core_bridge() {
        let output = plan_stopless_decision_context_signals_json(
            &json!({
                "adapterContext": {
                    "metadata": {
                        "routecodexPortStopMessageEnabled": false
                    }
                },
                "runtimeMetadata": {
                    "responsesResume": {
                        "toolOutputsDetailed": [{ "tool_call_id": "call_1" }]
                    }
                },
                "capturedRequest": {
                    "system": "<collaboration_mode>Collaboration Mode: Plan</collaboration_mode>"
                }
            })
            .to_string(),
        )
        .expect("stopless decision context signals");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("stopless decision context signals json");
        assert_eq!(plan["portStopMessageDisabled"], true);
        assert_eq!(plan["hasResponsesSubmitToolOutputsResume"], true);
        assert_eq!(plan["planModeActive"], true);
    }

    #[test]
    fn plans_stopless_decision_context_goal_status_via_servertool_core_bridge() {
        let output = plan_stopless_decision_context_goal_status_json(
            &json!({
                "adapterContext": {
                    "stoplessGoalState": {
                        "status": "active",
                        "objective": "old",
                        "createdAt": 1,
                        "updatedAt": 2
                    },
                    "__rt": {
                        "stoplessGoalStateSource": "persisted"
                    }
                },
                "persistedGoalState": null
            })
            .to_string(),
        )
        .expect("stopless decision context goal plan");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("stopless decision context goal json");
        assert_eq!(plan["goalStatus"], "idle");
        assert_eq!(plan["hasRequestScopedGoalState"], false);
    }

    #[test]
    fn plans_stop_message_default_config_via_servertool_core_bridge() {
        let output = plan_stop_message_default_config_json(
            &json!({
                "tombstoneCleared": false,
                "configEnabled": true,
                "configText": " config ",
                "configMaxRepeats": 4.8,
                "envText": "env",
                "envMaxRepeats": "2"
            })
            .to_string(),
        )
        .expect("stop-message default config plan");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("stop-message default config json");
        assert_eq!(plan["enabled"], true);
        assert_eq!(plan["text"], "config");
        assert_eq!(plan["maxRepeats"], 4);
    }

    #[test]
    fn plans_client_exec_cli_projection_output_via_servertool_core_bridge() {
        let output = build_client_exec_cli_projection_output_json(
            &json!({
                "flowId": "stop_message_flow",
                "input": {
                    "continuationPrompt": "continue from bridge",
                    "repeatCount": 2,
                    "maxRepeats": 3
                },
                "stdoutPreview": "continue from bridge"
            })
            .to_string(),
        )
        .expect("client exec cli projection output");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("client exec cli projection json");
        assert_eq!(plan["toolName"], "stop_message_auto");
        assert_eq!(plan["flowId"], "stop_message_flow");
        assert_eq!(plan["repeatCount"], 2);
        assert_eq!(plan["maxRepeats"], 3);
        let command = plan["execCommand"].as_str().expect("exec command");
        assert!(command.contains("routecodex servertool run stop_message_auto"));
        assert!(command.contains("stdoutPreview"));
    }
}
