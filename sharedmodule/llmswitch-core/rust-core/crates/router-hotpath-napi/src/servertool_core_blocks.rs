// feature_id: hub.servertool_stopless_cli_continuation
//! NAPI blocks for servertool-core — stop gateway, loop guard, budget counter.

use servertool_core::auto_hook_execution_contract;
use servertool_core::auto_hook_queue_contract;
use servertool_core::blocked_report_contract;
use servertool_core::cli_contract;
use servertool_core::cli_contract::ServertoolClientVisibleProjectionShellInput;
use servertool_core::cli_result_guard;
use servertool_core::engine_preflight_contract;
use servertool_core::engine_runtime_action_contract;
use servertool_core::engine_selection_contract;
use servertool_core::engine_skip_contract;
use servertool_core::execution_branch_contract;
use servertool_core::execution_dispatch_contract;
use servertool_core::execution_handler_contract;
use servertool_core::execution_loop_effect_contract;
use servertool_core::execution_loop_runtime_action_contract;
use servertool_core::execution_outcome_runtime_action_contract;
use servertool_core::execution_state_contract;
use servertool_core::hook_skeleton_contract;
use servertool_core::loop_state_contract;
use servertool_core::orchestration_policy_contract;
use servertool_core::outcome_contract;
use servertool_core::pending_session_contract;
use servertool_core::persisted_lookup;
use servertool_core::pre_command_hook_contract;
use servertool_core::registry_contract;
use servertool_core::response_stage_runtime_action_contract;
use servertool_core::server_side_tool_entry_contract;
use servertool_core::stop_gateway_context;
use servertool_core::stop_message_compare_context;
use servertool_core::stop_message_counter;
use servertool_core::stop_message_default_config;
use servertool_core::stop_message_loop_guard;
use servertool_core::stop_message_persist_plan;
use servertool_core::stop_visible_text;
use servertool_core::stopless_cli_projection_context_contract;
use servertool_core::stopless_decision_context_signals;
use servertool_core::stopless_learned_note_contract;
use servertool_core::stopless_orchestration_contract;
use servertool_core::text_extraction;

const SERVERTOOL_INTERNAL_TOOL_NAMES: &[&str] = &[
    "continue_execution",
    "stop_message_auto",
    "reasoningStop",
    "web_search",
    "recursive_detection_guard",
    "vision_auto",
    "servertool_fixture",
];

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

pub fn extract_stop_message_blocked_report_from_messages_json(
    input_json: &str,
) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize blocked-report messages input: {e}"))?;
    serde_json::to_string(&blocked_report_contract::extract_blocked_report_from_messages(&input))
        .map_err(|e| format!("serialize blocked-report output: {e}"))
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

pub fn resolve_runtime_stop_message_state_from_metadata_center_json(
    input_json: &str,
) -> Result<String, String> {
    let input: persisted_lookup::RuntimeStopMessageStateFromMetadataCenterInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize runtime stop-message metadata center input: {e}"))?;
    let snapshot =
        persisted_lookup::resolve_runtime_stop_message_state_from_metadata_center(&input);
    serde_json::to_string(&snapshot)
        .map_err(|e| format!("serialize runtime stop-message metadata center state: {e}"))
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

pub fn plan_stop_message_default_config_json(input_json: &str) -> Result<String, String> {
    let input: stop_message_default_config::StopMessageDefaultConfigInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message default config input: {e}"))?;
    serde_json::to_string(&stop_message_default_config::plan_stop_message_default_config(&input))
        .map_err(|e| format!("serialize stop-message default config plan: {e}"))
}

pub fn plan_stop_message_persist_snapshot_json(input_json: &str) -> Result<String, String> {
    let input: stop_message_persist_plan::StopMessagePersistPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stop-message persist plan input: {e}"))?;
    serde_json::to_string(&stop_message_persist_plan::plan_stop_message_persist_snapshot(&input))
        .map_err(|e| format!("serialize stop-message persist plan: {e}"))
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

pub fn plan_runtime_pre_command_state_selection_json(input_json: &str) -> Result<String, String> {
    let input: pre_command_hook_contract::RuntimePreCommandStateSelectionInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize runtime pre-command state selection input: {e}"))?;
    serde_json::to_string(
        &pre_command_hook_contract::plan_runtime_pre_command_state_selection(&input),
    )
    .map_err(|e| format!("serialize runtime pre-command state selection plan: {e}"))
}

pub fn plan_runtime_pre_command_state_runtime_action_json(
    input_json: &str,
) -> Result<String, String> {
    let input: pre_command_hook_contract::RuntimePreCommandStateRuntimeActionInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize runtime pre-command state runtime action input: {e}")
        })?;
    let plan = pre_command_hook_contract::plan_runtime_pre_command_state_runtime_action(&input)?;
    serde_json::to_string(&plan)
        .map_err(|e| format!("serialize runtime pre-command state runtime action plan: {e}"))
}

pub fn plan_auto_hook_execution_decision_json(input_json: &str) -> Result<String, String> {
    let input: auto_hook_execution_contract::AutoHookExecutionDecisionInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize auto-hook execution decision input: {e}"))?;
    serde_json::to_string(&auto_hook_execution_contract::plan_auto_hook_execution_decision(input))
        .map_err(|e| format!("serialize auto-hook execution decision plan: {e}"))
}

pub fn plan_auto_hook_queue_progress_json(input_json: &str) -> Result<String, String> {
    let input: auto_hook_queue_contract::AutoHookQueueProgressInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize auto-hook queue progress input: {e}"))?;
    serde_json::to_string(&auto_hook_queue_contract::plan_auto_hook_queue_progress(
        input,
    ))
    .map_err(|e| format!("serialize auto-hook queue progress plan: {e}"))
}

pub fn plan_servertool_execution_branch_json(input_json: &str) -> Result<String, String> {
    let input: execution_branch_contract::ServertoolExecutionBranchPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool execution branch input: {e}"))?;
    serde_json::to_string(&execution_branch_contract::plan_servertool_execution_branch(input))
        .map_err(|e| format!("serialize servertool execution branch plan: {e}"))
}

pub fn plan_servertool_engine_preflight_json(input_json: &str) -> Result<String, String> {
    let input: engine_preflight_contract::ServertoolEnginePreflightInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool engine preflight input: {e}"))?;
    serde_json::to_string(&engine_preflight_contract::plan_servertool_engine_preflight(input))
        .map_err(|e| format!("serialize servertool engine preflight plan: {e}"))
}

pub fn plan_servertool_engine_runtime_action_json(input_json: &str) -> Result<String, String> {
    let input: engine_runtime_action_contract::ServertoolEngineRuntimeActionInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool engine runtime action input: {e}"))?;
    let plan = engine_runtime_action_contract::plan_servertool_engine_runtime_action(input)?;
    serde_json::to_string(&plan)
        .map_err(|e| format!("serialize servertool engine runtime action plan: {e}"))
}

pub fn plan_servertool_engine_skip_json(input_json: &str) -> Result<String, String> {
    let input: engine_skip_contract::ServertoolEngineSkipInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool engine skip input: {e}"))?;
    serde_json::to_string(&engine_skip_contract::plan_servertool_engine_skip(input))
        .map_err(|e| format!("serialize servertool engine skip plan: {e}"))
}

pub fn plan_servertool_execution_outcome_runtime_action_json(
    input_json: &str,
) -> Result<String, String> {
    let input: execution_outcome_runtime_action_contract::ServertoolExecutionOutcomeRuntimeActionInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize servertool execution outcome runtime action input: {e}")
        })?;
    serde_json::to_string(
        &execution_outcome_runtime_action_contract::plan_servertool_execution_outcome_runtime_action(
            input,
        ),
    )
    .map_err(|e| format!("serialize servertool execution outcome runtime action plan: {e}"))
}

pub fn plan_servertool_execution_loop_runtime_action_json(
    input_json: &str,
) -> Result<String, String> {
    let input: execution_loop_runtime_action_contract::ServertoolExecutionLoopRuntimeActionInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize servertool execution loop runtime action input: {e}")
        })?;
    serde_json::to_string(
        &execution_loop_runtime_action_contract::plan_servertool_execution_loop_runtime_action(
            input,
        ),
    )
    .map_err(|e| format!("serialize servertool execution loop runtime action plan: {e}"))
}

pub fn plan_servertool_execution_loop_effect_json(input_json: &str) -> Result<String, String> {
    let input: execution_loop_effect_contract::ServertoolExecutionLoopEffectInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool execution loop effect input: {e}"))?;
    serde_json::to_string(
        &execution_loop_effect_contract::plan_servertool_execution_loop_effect(input),
    )
    .map_err(|e| format!("serialize servertool execution loop effect plan: {e}"))
}

pub fn plan_servertool_response_stage_runtime_action_json(
    input_json: &str,
) -> Result<String, String> {
    let input: response_stage_runtime_action_contract::ServertoolResponseStageRuntimeActionInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize servertool response stage runtime action input: {e}")
        })?;
    serde_json::to_string(
        &response_stage_runtime_action_contract::plan_servertool_response_stage_runtime_action(
            input,
        ),
    )
    .map_err(|e| format!("serialize servertool response stage runtime action plan: {e}"))
}

pub fn plan_servertool_entry_preflight_json(input_json: &str) -> Result<String, String> {
    let input: server_side_tool_entry_contract::ServertoolEntryPreflightInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool entry preflight input: {e}"))?;
    serde_json::to_string(&server_side_tool_entry_contract::plan_servertool_entry_preflight(input))
        .map_err(|e| format!("serialize servertool entry preflight plan: {e}"))
}

pub fn plan_servertool_registry_registration_action_json(
    input_json: &str,
) -> Result<String, String> {
    let input: registry_contract::ServertoolRegistryRegistrationActionInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize servertool registry registration action input: {e}")
        })?;
    serde_json::to_string(&registry_contract::plan_servertool_registry_registration_action(input))
        .map_err(|e| format!("serialize servertool registry registration action plan: {e}"))
}

pub fn plan_servertool_registry_lookup_action_json(input_json: &str) -> Result<String, String> {
    let input: registry_contract::ServertoolRegistryLookupActionInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool registry lookup action input: {e}"))?;
    serde_json::to_string(&registry_contract::plan_servertool_registry_lookup_action(
        input,
    ))
    .map_err(|e| format!("serialize servertool registry lookup action plan: {e}"))
}

pub fn plan_servertool_registry_auto_hook_descriptors_json(
    input_json: &str,
) -> Result<String, String> {
    let input: Vec<registry_contract::ServertoolRegistryAutoHookDescriptorInput> =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize servertool registry auto hook descriptors input: {e}")
        })?;
    let plan = registry_contract::plan_servertool_registry_auto_hook_descriptors(input)
        .map_err(|e| format!("plan servertool registry auto hook descriptors: {e}"))?;
    serde_json::to_string(&plan)
        .map_err(|e| format!("serialize servertool registry auto hook descriptors plan: {e}"))
}

pub fn plan_servertool_registry_projection_json(input_json: &str) -> Result<String, String> {
    let input: registry_contract::ServertoolRegistryProjectionInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool registry projection input: {e}"))?;
    let plan = registry_contract::plan_servertool_registry_projection(input)
        .map_err(|e| format!("plan servertool registry projection: {e}"))?;
    serde_json::to_string(&plan)
        .map_err(|e| format!("serialize servertool registry projection plan: {e}"))
}

pub fn plan_servertool_registry_source_projection_json(input_json: &str) -> Result<String, String> {
    let input: registry_contract::ServertoolRegistrySourceProjectionInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool registry source projection input: {e}"))?;
    let plan = registry_contract::plan_servertool_registry_source_projection(input)
        .map_err(|e| format!("plan servertool registry source projection: {e}"))?;
    serde_json::to_string(&plan)
        .map_err(|e| format!("serialize servertool registry source projection plan: {e}"))
}

pub fn plan_stopless_cli_projection_context_json(input_json: &str) -> Result<String, String> {
    let input: stopless_cli_projection_context_contract::StoplessCliProjectionContextInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stopless cli projection context input: {e}"))?;
    serde_json::to_string(
        &stopless_cli_projection_context_contract::plan_stopless_cli_projection_context(input),
    )
    .map_err(|e| format!("serialize stopless cli projection context plan: {e}"))
}

pub fn normalize_stopless_trigger_hint_for_metadata_json(
    input_json: &str,
) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize stopless trigger hint input: {e}"))?;
    let reason_code = input
        .get("reasonCode")
        .or_else(|| input.get("reason_code"))
        .or_else(|| input.get("triggerHint"))
        .or_else(|| input.get("trigger_hint"))
        .and_then(serde_json::Value::as_str);
    Ok(cli_contract::normalize_stopless_trigger_hint_for_metadata(reason_code).to_string())
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

pub fn plan_servertool_handler_contract_error_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool handler contract error input: {e}"))?;
    let kind = input
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    match kind {
        "handler_failed" => {
            let parsed: execution_handler_contract::ServertoolHandlerFailedErrorInput =
                serde_json::from_value(input)
                    .map_err(|e| format!("deserialize handler failed error input: {e}"))?;
            serde_json::to_string(
                &execution_handler_contract::plan_servertool_handler_failed_error(&parsed),
            )
            .map_err(|e| format!("serialize handler failed error plan: {e}"))
        }
        "unsupported_backend_plan_kind" => {
            let parsed: execution_handler_contract::ServertoolUnsupportedBackendPlanKindErrorInput =
                serde_json::from_value(input)
                    .map_err(|e| format!("deserialize unsupported backend kind input: {e}"))?;
            serde_json::to_string(
                &execution_handler_contract::plan_servertool_unsupported_backend_plan_kind_error(
                    &parsed,
                ),
            )
            .map_err(|e| format!("serialize unsupported backend kind error plan: {e}"))
        }
        "invalid_handler_plan_missing_finalize" => {
            let parsed: execution_handler_contract::ServertoolInvalidHandlerPlanErrorInput =
                serde_json::from_value(input).map_err(|e| {
                    format!("deserialize invalid handler plan missing finalize input: {e}")
                })?;
            serde_json::to_string(
                &execution_handler_contract::plan_servertool_invalid_handler_plan_missing_finalize_error(
                    &parsed,
                ),
            )
            .map_err(|e| format!("serialize invalid handler plan missing finalize error plan: {e}"))
        }
        "invalid_handler_plan_result" => {
            let parsed: execution_handler_contract::ServertoolInvalidHandlerPlanErrorInput =
                serde_json::from_value(input)
                    .map_err(|e| format!("deserialize invalid handler plan result input: {e}"))?;
            serde_json::to_string(
                &execution_handler_contract::plan_servertool_invalid_handler_plan_result_error(
                    &parsed,
                ),
            )
            .map_err(|e| format!("serialize invalid handler plan result error plan: {e}"))
        }
        _ => Err(format!(
            "deserialize servertool handler contract error input: unknown kind {kind}"
        )),
    }
}

pub fn plan_servertool_execution_dispatch_error_json(input_json: &str) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool execution-dispatch error input: {e}"))?;
    let kind = input
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    match kind {
        "dispatch_spec_mismatch" => {
            let parsed: execution_dispatch_contract::ServertoolDispatchSpecMismatchErrorInput =
                serde_json::from_value(input)
                    .map_err(|e| format!("deserialize dispatch spec mismatch error input: {e}"))?;
            serde_json::to_string(
                &execution_dispatch_contract::plan_servertool_dispatch_spec_mismatch_error(&parsed),
            )
            .map_err(|e| format!("serialize dispatch spec mismatch error plan: {e}"))
        }
        "invalid_mixed_client_tools_outcome" => {
            let parsed:
                execution_dispatch_contract::ServertoolInvalidMixedClientToolsOutcomeErrorInput =
                serde_json::from_value(input).map_err(|e| {
                    format!("deserialize invalid mixed client tools outcome error input: {e}")
                })?;
            serde_json::to_string(
                &execution_dispatch_contract::plan_servertool_invalid_mixed_client_tools_outcome_error(
                    &parsed,
                ),
            )
            .map_err(|e| format!("serialize invalid mixed client tools outcome error plan: {e}"))
        }
        "missing_followup_contract" => {
            let parsed: execution_dispatch_contract::ServertoolMissingFollowupContractErrorInput =
                serde_json::from_value(input).map_err(|e| {
                    format!("deserialize missing followup contract error input: {e}")
                })?;
            serde_json::to_string(
                &execution_dispatch_contract::plan_servertool_missing_followup_contract_error(
                    &parsed,
                ),
            )
            .map_err(|e| format!("serialize missing followup contract error plan: {e}"))
        }
        _ => Err(format!(
            "deserialize servertool execution-dispatch error input: unknown kind {kind}"
        )),
    }
}

pub fn plan_servertool_handler_runtime_action_json(input_json: &str) -> Result<String, String> {
    let input: execution_handler_contract::ServertoolHandlerRuntimeActionInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool handler runtime action input: {e}"))?;
    serde_json::to_string(
        &execution_handler_contract::plan_servertool_handler_runtime_action(&input),
    )
    .map_err(|e| format!("serialize servertool handler runtime action plan: {e}"))
}

pub fn create_servertool_execution_loop_state_json() -> Result<String, String> {
    serde_json::to_string(&execution_state_contract::create_servertool_execution_loop_state())
        .map_err(|e| format!("serialize servertool execution loop state: {e}"))
}

pub fn append_servertool_executed_record_json(input_json: &str) -> Result<String, String> {
    let input: execution_state_contract::ServertoolAppendExecutedRecordInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool append executed record input: {e}"))?;
    serde_json::to_string(&execution_state_contract::append_executed_tool_record(
        input,
    ))
    .map_err(|e| format!("serialize servertool appended execution state: {e}"))
}

pub fn plan_servertool_materialization_progress_json(input_json: &str) -> Result<String, String> {
    let input: execution_handler_contract::ServertoolMaterializationProgressInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool materialization progress input: {e}"))?;
    serde_json::to_string(
        &execution_handler_contract::plan_servertool_materialization_progress(&input),
    )
    .map_err(|e| format!("serialize servertool materialization progress plan: {e}"))
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

pub fn plan_servertool_state_load_failed_error_json(input_json: &str) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolStateLoadFailedErrorInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool state-load error input: {e}"))?;
    serde_json::to_string(
        &orchestration_policy_contract::plan_servertool_state_load_failed_error(&input)?,
    )
    .map_err(|e| format!("serialize servertool state-load error: {e}"))
}

pub fn plan_servertool_required_response_hook_empty_error_json(
    input_json: &str,
) -> Result<String, String> {
    let input: orchestration_policy_contract::ServertoolRequiredResponseHookEmptyErrorInput =
        serde_json::from_str(input_json).map_err(|e| {
            format!("deserialize servertool required response hook empty error input: {e}")
        })?;
    serde_json::to_string(
        &orchestration_policy_contract::plan_servertool_required_response_hook_empty_error(&input)?,
    )
    .map_err(|e| format!("serialize servertool required response hook empty error: {e}"))
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

pub fn plan_stopless_orchestration_action_json(input_json: &str) -> Result<String, String> {
    let input: stopless_orchestration_contract::StoplessOrchestrationPlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stopless orchestration input: {e}"))?;
    serde_json::to_string(
        &stopless_orchestration_contract::plan_stopless_orchestration_action(input),
    )
    .map_err(|e| format!("serialize stopless orchestration plan: {e}"))
}

pub fn plan_stopless_learned_note_write_json(input_json: &str) -> Result<String, String> {
    let input: stopless_learned_note_contract::StoplessLearnedNotePlanInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize stopless learned-note input: {e}"))?;
    serde_json::to_string(&stopless_learned_note_contract::plan_stopless_learned_note_write(input))
        .map_err(|e| format!("serialize stopless learned-note plan: {e}"))
}

pub fn validate_servertool_hook_skeleton_phase_json(input_json: &str) -> Result<String, String> {
    let input: hook_skeleton_contract::ServertoolHookSpec = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize servertool hook skeleton spec: {e}"))?;
    let output =
        hook_skeleton_contract::validate_servertool_hook_spec(&input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output)
        .map_err(|e| format!("serialize servertool hook skeleton projection: {e}"))
}

pub fn plan_servertool_hook_schedule_json(input_json: &str) -> Result<String, String> {
    let input: hook_skeleton_contract::ServertoolHookSchedulerInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize servertool hook scheduler input: {e}"))?;
    let output =
        hook_skeleton_contract::plan_servertool_hook_schedule(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output)
        .map_err(|e| format!("serialize servertool hook scheduler plan: {e}"))
}

pub fn build_client_visible_projection_shell_json(input_json: &str) -> Result<String, String> {
    let input: ServertoolClientVisibleProjectionShellInput = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize projection shell input: {e}"))?;
    let output =
        cli_contract::build_client_visible_projection_shell(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&output).map_err(|e| format!("serialize projection shell: {e}"))
}

pub fn build_servertool_cli_projection_execution_context_json(
    input_json: &str,
) -> Result<String, String> {
    let input: cli_contract::ServertoolCliProjectionExecutionContextInput =
        serde_json::from_str(input_json)
            .map_err(|e| format!("deserialize cli projection execution context input: {e}"))?;
    let output = cli_contract::build_servertool_cli_projection_execution_context(input)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&output)
        .map_err(|e| format!("serialize cli projection execution context: {e}"))
}

pub fn build_servertool_handler_error_tool_output_payload_json(
    input_json: &str,
) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize handler error tool output input: {e}"))?;
    let mut output = input
        .get("base")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    let tool_call_id = input
        .get("toolCallId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "handler error tool output missing toolCallId".to_string())?;
    let tool_name = input
        .get("toolName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "handler error tool output missing toolName".to_string())?;
    let message = input
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let retryable = input
        .get("retryable")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let content = serde_json::to_string(&serde_json::json!({
        "ok": false,
        "tool": tool_name,
        "message": message,
        "retryable": retryable
    }))
    .map_err(|e| format!("serialize handler error tool output content: {e}"))?;
    output.insert(
        "tool_outputs".to_string(),
        serde_json::json!([{
            "tool_call_id": tool_call_id,
            "name": tool_name,
            "content": content
        }]),
    );
    serde_json::to_string(&serde_json::Value::Object(output))
        .map_err(|e| format!("serialize handler error tool output payload: {e}"))
}

pub fn collect_servertool_additional_client_tool_calls_json(
    input_json: &str,
) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize additional client tool calls input: {e}"))?;
    let projected_tool_call_id = input
        .get("projectedToolCallId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "additional client tool calls missing projectedToolCallId".to_string())?;
    let output = input
        .get("base")
        .and_then(|base| base.get("choices"))
        .and_then(serde_json::Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|tool_call| {
            let row = match tool_call.as_object() {
                Some(row) => row,
                None => return false,
            };
            if row
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                == Some(projected_tool_call_id)
            {
                return false;
            }
            let name = row
                .get("function")
                .and_then(serde_json::Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            !matches!(name, Some(name) if SERVERTOOL_INTERNAL_TOOL_NAMES.contains(&name))
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&output)
        .map_err(|e| format!("serialize additional client tool calls output: {e}"))
}

pub fn is_servertool_client_exec_cli_projection_tool_call_json(
    input_json: &str,
) -> Result<String, String> {
    let input: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize cli projection tool call input: {e}"))?;
    let execution_mode = input
        .get("executionMode")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    Ok(if execution_mode == "client_exec_cli_projection"
        && outcome_contract::is_client_exec_cli_projection("stop_message_auto")
    {
        "true"
    } else {
        "false"
    }
    .to_string())
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

pub fn extract_servertool_cli_result_route_hint_from_request_json(
    input_json: &str,
) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize cli result route hint input: {e}"))?;
    serde_json::to_string(
        &cli_result_guard::extract_servertool_cli_result_route_hint_from_request(&payload),
    )
    .map_err(|e| format!("serialize cli result route hint: {e}"))
}

pub fn extract_stop_message_auto_cli_result_snapshot_from_request_json(
    input_json: &str,
) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(input_json)
        .map_err(|e| format!("deserialize stopless cli result snapshot input: {e}"))?;
    serde_json::to_string(
        &cli_result_guard::extract_stop_message_auto_cli_result_snapshot_from_request(&payload),
    )
    .map_err(|e| format!("serialize stopless cli result snapshot: {e}"))
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

pub fn extract_current_assistant_reasoning_stop_arguments_json(
    input_json: &str,
) -> Result<String, String> {
    let payload: serde_json::Value = serde_json::from_str(input_json).map_err(|e| {
        format!("deserialize current assistant reasoningStop arguments payload: {e}")
    })?;
    let arguments = stop_visible_text::extract_current_assistant_reasoning_stop_arguments(&payload);
    serde_json::to_string(&arguments)
        .map_err(|e| format!("serialize current assistant reasoningStop arguments: {e}"))
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
    fn stop_gateway_bridge_uses_skeleton_response_hook_internal_stop_tools() {
        let raw = inspect_stop_gateway_signal(
            &json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_reasoning_stop_1",
                            "function": {
                                "name": "reasoningStop",
                                "arguments": "{\"reason\":\"missing\",\"stopreason\":2}"
                            }
                        }]
                    }
                }]
            })
            .to_string(),
        )
        .expect("stop gateway");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["observed"], true);
        assert_eq!(parsed["eligible"], true);
        assert_eq!(
            parsed["reason"],
            "finish_reason_tool_calls_internal_stop_tool"
        );
    }

    #[test]
    fn stop_gateway_bridge_keeps_unregistered_tool_calls_ineligible() {
        let raw = inspect_stop_gateway_signal(
            &json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_exec_1",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        }]
                    }
                }]
            })
            .to_string(),
        )
        .expect("stop gateway");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["observed"], true);
        assert_eq!(parsed["eligible"], false);
        assert_eq!(parsed["reason"], "finish_reason_tool_calls");
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
            json!("decision=trigger reason=native_decision armed=true mode=auto allowModeOnly=false max=3 used=1 left=2 active=true stopEligible=true compaction=false seed=true obs=none stable=2 toolSig=none")
        );
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
            &json!("visible\n<rcc_stop_schema>{\"stopreason\":\"blocked\"}</rcc_stop_schema>\n停止原因：blocked")
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
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_servertool",
                    "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\"}"
                }]
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
    fn resolves_runtime_stop_message_state_via_metadata_center_bridge() {
        let raw = resolve_runtime_stop_message_state_json(
            &json!({
                "metadataCenterSnapshot": {
                    "runtimeControl": {
                        "stopless": {
                            "flowId": "stop_message_flow",
                            "continuationPrompt": "continue from center",
                            "repeatCount": 2,
                            "maxRepeats": 3
                        }
                    }
                }
            })
            .to_string(),
        )
        .expect("runtime stop state");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["text"], "continue from center");
        assert_eq!(parsed["maxRepeats"], 3);
        assert_eq!(parsed["used"], 2);
        assert_eq!(parsed["source"], "servertool.stop_message");
        assert_eq!(parsed["stageMode"], "on");
        assert!(parsed.get("repeatCount").is_none());
    }

    #[test]
    fn resolves_runtime_stop_message_state_from_metadata_center_via_servertool_core_bridge() {
        let raw = resolve_runtime_stop_message_state_from_metadata_center_json(
            &json!({
                "runtimeMetadata": {
                    "metadataCenterSnapshot": {
                        "runtimeControl": {
                            "stopless": {
                                "flowId": "stop_message_flow",
                                "continuationPrompt": "continue from output",
                                "repeatCount": 1,
                                "maxRepeats": 4
                            }
                        }
                    }
                }
            })
            .to_string(),
        )
        .expect("runtime stop state from metadata center");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["text"], "continue from output");
        assert_eq!(parsed["maxRepeats"], 4);
        assert_eq!(parsed["used"], 1);
        assert_eq!(parsed["source"], "servertool.stop_message");
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
    fn plans_stopless_orchestration_action_via_servertool_core_bridge() {
        let cli = plan_stopless_orchestration_action_json(
            &json!({
                "flowId": "stop_message_flow",
                "execution": {
                    "flowId": "stop_message_flow",
                    "context": { "requestTruth": { "sessionId": "sess-cli" } }
                }
            })
            .to_string(),
        )
        .expect("stopless cli action");
        let cli_plan: serde_json::Value =
            serde_json::from_str(&cli).expect("stopless cli action json");
        assert_eq!(cli_plan["isStopMessageFlow"], true);
        assert_eq!(cli_plan["reason"], "stop_message_cli_projection");

        let terminal = plan_stopless_orchestration_action_json(
            &json!({
                "flowId": "stop_message_flow",
                "execution": {
                    "flowId": "stop_message_flow",
                    "context": {
                        "stopMessageTerminalFinal": true,
                        "requestTruth": { "sessionId": "sess-term" }
                    }
                }
            })
            .to_string(),
        )
        .expect("stopless terminal action");
        let terminal_plan: serde_json::Value =
            serde_json::from_str(&terminal).expect("stopless terminal action json");
        assert_eq!(terminal_plan["action"], "terminal_final");
        assert_eq!(terminal_plan["reason"], "stop_message_terminal_final");

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
        assert_eq!(followup_plan["action"], "cli_projection");
        assert_eq!(followup_plan["isStopMessageFlow"], false);
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
        assert_eq!(plan["tombstone"]["cleared"], false);
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
        assert_eq!(plan["stageMode"], "on");
        assert_eq!(plan["tombstone"]["exhaustedDefault"], false);
    }

    #[test]
    fn plans_stopless_decision_context_signals_via_servertool_core_bridge() {
        let output = plan_stopless_decision_context_signals_json(
            &json!({
                "runtimeMetadata": {
                    "runtime_control": {
                        "stopMessageEnabled": false
                    },
                    "responsesResume": {
                        "toolOutputsDetailed": [{ "tool_call_id": "call_1" }]
                    }
                }
            })
            .to_string(),
        )
        .expect("stopless decision context signals");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("stopless decision context signals json");
        assert_eq!(plan["portStopMessageDisabled"], true);
        assert_eq!(plan["hasResponsesSubmitToolOutputsResume"], true);
        assert_eq!(plan["planModeActive"], false);
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
    fn plans_stop_message_persist_snapshot_via_servertool_core_bridge() {
        let output = plan_stop_message_persist_snapshot_json(
            &json!({
                "schemaGate": { "count_budget": true, "max_repeats": 3 },
                "decision": { "used": 1, "max_repeats": 30 },
                "stateUpdate": { "used": 2, "text": "keep going" },
                "defaultText": "default",
                "schemaUsedBeforeCount": 1
            })
            .to_string(),
        )
        .expect("stop-message persist plan");
        let plan: serde_json::Value =
            serde_json::from_str(&output).expect("stop-message persist plan json");
        assert_eq!(plan["compareMaxRepeats"], 3);
        assert_eq!(plan["compareRemaining"], 2);
        assert_eq!(plan["nextMaxRepeats"], 3);
        assert_eq!(plan["nextUsed"], 2);
        assert_eq!(plan["snapshot"]["text"], "keep going");
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
                }
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
        assert!(command.contains("routecodex hook run reasoningStop"));
        assert!(!command.contains("continuationPrompt"));
        assert!(!command.contains("schemaGuidance"));
        assert!(!command.contains("stdoutPreview"));
    }

    #[test]
    fn builds_servertool_handler_error_tool_output_payload_via_servertool_core_bridge() {
        let output = build_servertool_handler_error_tool_output_payload_json(
            &serde_json::json!({
                "base": { "id": "chatcmpl-test" },
                "toolCallId": "call_fail_1",
                "toolName": "failfast_test_tool",
                "message": "boom-from-execution-shell"
            })
            .to_string(),
        )
        .expect("handler error tool output");
        let parsed: serde_json::Value =
            serde_json::from_str(&output).expect("parse handler error tool output");
        assert_eq!(parsed["id"], "chatcmpl-test");
        assert_eq!(parsed["tool_outputs"][0]["tool_call_id"], "call_fail_1");
        assert_eq!(parsed["tool_outputs"][0]["name"], "failfast_test_tool");
        let content = parsed["tool_outputs"][0]["content"]
            .as_str()
            .expect("tool output content");
        let content_json: serde_json::Value =
            serde_json::from_str(content).expect("parse tool output content");
        assert_eq!(content_json["ok"], false);
        assert_eq!(content_json["tool"], "failfast_test_tool");
        assert_eq!(content_json["message"], "boom-from-execution-shell");
        assert_eq!(content_json["retryable"], true);
    }

    #[test]
    fn collects_servertool_additional_client_tool_calls_via_servertool_core_bridge() {
        let output = collect_servertool_additional_client_tool_calls_json(
            &serde_json::json!({
                "projectedToolCallId": "call_servertool_fixture_1",
                "base": {
                    "choices": [{
                        "message": {
                            "tool_calls": [
                                {
                                    "id": "call_servertool_fixture_1",
                                    "type": "function",
                                    "function": {
                                        "name": "servertool_fixture",
                                        "arguments": "{\"value\":1}"
                                    }
                                },
                                {
                                    "id": "call_exec_command_1",
                                    "type": "function",
                                    "function": {
                                        "name": "exec_command",
                                        "arguments": "{\"cmd\":\"echo hi\"}"
                                    }
                                }
                            ]
                        }
                    }]
                }
            })
            .to_string(),
        )
        .expect("additional client tool calls");
        let parsed: serde_json::Value =
            serde_json::from_str(&output).expect("parse additional client tool calls");
        let calls = parsed.as_array().expect("tool call array");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "call_exec_command_1");
        assert_eq!(calls[0]["function"]["name"], "exec_command");
    }

    #[test]
    fn checks_servertool_client_exec_cli_projection_tool_call_via_servertool_core_bridge() {
        let truthy = is_servertool_client_exec_cli_projection_tool_call_json(
            &serde_json::json!({
                "executionMode": "client_exec_cli_projection"
            })
            .to_string(),
        )
        .expect("truthy cli projection");
        assert_eq!(truthy, "true");

        let falsy = is_servertool_client_exec_cli_projection_tool_call_json(
            &serde_json::json!({
                "executionMode": "guarded"
            })
            .to_string(),
        )
        .expect("falsy cli projection");
        assert_eq!(falsy, "false");
    }
}

#[test]
fn plans_runtime_pre_command_state_selection_via_servertool_core_bridge() {
    let plan = plan_runtime_pre_command_state_selection_json(
        &serde_json::json!({
            "runtimeControlPreCommandState": { "preCommandScriptPath": "/tmp/runtime.sh" }
        })
        .to_string(),
    )
    .expect("state selection plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(parsed["action"], "use_selected");
    assert_eq!(parsed["source"], "runtime_control");
    assert_eq!(
        parsed["state"]["preCommandScriptPath"],
        serde_json::Value::String("/tmp/runtime.sh".to_string())
    );

    let skip = plan_runtime_pre_command_state_selection_json(
        &serde_json::json!({
            "runtimeControlPreCommandState": null
        })
        .to_string(),
    )
    .expect("skip state selection plan");
    let skip_parsed: serde_json::Value = serde_json::from_str(&skip).expect("parse skip plan");
    assert_eq!(skip_parsed["action"], "use_selected");
    assert_eq!(skip_parsed["source"], "none");
    assert!(skip_parsed.get("state").is_none() || skip_parsed["state"].is_null());
}

#[test]
fn plans_runtime_pre_command_state_runtime_action_via_servertool_core_bridge() {
    let plan = plan_runtime_pre_command_state_runtime_action_json(
        &serde_json::json!({
            "runtimeControlPreCommandState": { "preCommandScriptPath": "/tmp/runtime.sh" }
        })
        .to_string(),
    )
    .expect("runtime action plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse runtime action");
    assert_eq!(parsed["action"], "use_selected");
    assert_eq!(parsed["source"], "runtime_control");
    assert_eq!(
        parsed["state"]["preCommandScriptPath"],
        serde_json::Value::String("/tmp/runtime.sh".to_string())
    );

    let empty_plan = plan_runtime_pre_command_state_runtime_action_json(
        &serde_json::json!({
            "runtimeControlPreCommandState": null
        })
        .to_string(),
    )
    .expect("runtime action empty plan");
    let empty_parsed: serde_json::Value =
        serde_json::from_str(&empty_plan).expect("parse runtime action empty");
    assert_eq!(empty_parsed["action"], "use_selected");
    assert_eq!(empty_parsed["source"], "none");
    assert!(empty_parsed.get("state").is_none() || empty_parsed["state"].is_null());
}

#[test]
fn plans_servertool_entry_preflight_via_servertool_core_bridge() {
    let passthrough = plan_servertool_entry_preflight_json(
        &serde_json::json!({
            "hasBaseObject": false,
            "adapterClientDisconnected": false
        })
        .to_string(),
    )
    .expect("passthrough entry preflight");
    let passthrough_parsed: serde_json::Value =
        serde_json::from_str(&passthrough).expect("parse passthrough preflight");
    assert_eq!(
        passthrough_parsed["action"],
        serde_json::Value::String("return_passthrough_non_object_chat".to_string())
    );

    let disconnected = plan_servertool_entry_preflight_json(
        &serde_json::json!({
            "hasBaseObject": true,
            "adapterClientDisconnected": true
        })
        .to_string(),
    )
    .expect("disconnected entry preflight");
    let disconnected_parsed: serde_json::Value =
        serde_json::from_str(&disconnected).expect("parse disconnected preflight");
    assert_eq!(
        disconnected_parsed["action"],
        serde_json::Value::String("throw_client_disconnected".to_string())
    );
}

#[test]
fn plans_auto_hook_execution_decision_via_servertool_core_bridge() {
    let plan = plan_auto_hook_execution_decision_json(
        &serde_json::json!({
            "hookId": "stop_message_auto",
            "phase": "default",
            "priority": 40,
            "queue": "A_optional",
            "queueIndex": 1,
            "queueTotal": 1,
            "hasPlannedResult": true,
            "hasMaterializedResult": true,
            "materializedFlowId": "stop_message_flow"
        })
        .to_string(),
    )
    .expect("auto-hook execution plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(parsed["action"], "return_result");
    assert_eq!(parsed["traceEvent"]["result"], "match");
    assert_eq!(
        parsed["traceEvent"]["flowId"],
        serde_json::Value::String("stop_message_flow".to_string())
    );

    let planned_null = plan_auto_hook_execution_decision_json(
        &serde_json::json!({
            "hookId": "vision_auto",
            "phase": "default",
            "priority": 20,
            "queue": "A_optional",
            "queueIndex": 1,
            "queueTotal": 2,
            "hasPlannedResult": false,
            "hasMaterializedResult": false
        })
        .to_string(),
    )
    .expect("auto-hook planned-null plan");
    let planned_null_parsed: serde_json::Value =
        serde_json::from_str(&planned_null).expect("parse planned-null plan");
    assert_eq!(planned_null_parsed["action"], "continue_queue");
    assert_eq!(
        planned_null_parsed["traceEvent"]["reason"],
        serde_json::Value::String("predicate_false".to_string())
    );
}

#[test]
fn plans_auto_hook_queue_progress_via_servertool_core_bridge() {
    let plan = plan_auto_hook_queue_progress_json(
        &serde_json::json!({
            "queueOrder": ["A_optional", "B_mandatory"],
            "currentQueue": "A_optional",
            "resultPresent": false
        })
        .to_string(),
    )
    .expect("auto-hook queue progress plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(parsed["action"], "continue_next_queue");
    assert_eq!(
        parsed["nextQueue"],
        serde_json::Value::String("B_mandatory".to_string())
    );
}

#[test]
fn plans_servertool_handler_contract_error_via_servertool_core_bridge() {
    let plan = plan_servertool_handler_contract_error_json(
        &serde_json::json!({
            "kind": "handler_failed",
            "toolName": "tool_a",
            "requestId": "req-1",
            "entryEndpoint": "/v1/responses",
            "providerProtocol": "openai-responses",
            "error": "boom"
        })
        .to_string(),
    )
    .expect("handler contract error plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(parsed["code"], "SERVERTOOL_HANDLER_FAILED");
    assert_eq!(parsed["details"]["toolName"], "tool_a");
}

#[test]
fn plans_servertool_execution_dispatch_error_via_servertool_core_bridge() {
    let plan = plan_servertool_execution_dispatch_error_json(
        &serde_json::json!({
            "kind": "dispatch_spec_mismatch",
            "requestId": "req-1",
            "toolName": "web_search",
            "nativeExecutionMode": "guarded",
            "tsExecutionMode": "legacy"
        })
        .to_string(),
    )
    .expect("execution dispatch error plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(parsed["code"], "SERVERTOOL_HANDLER_FAILED");
    assert_eq!(
        parsed["message"],
        "[servertool] dispatch spec mismatch: web_search: native=guarded ts=legacy"
    );
}

#[test]
fn plans_servertool_handler_runtime_action_via_servertool_core_bridge() {
    let plan = plan_servertool_handler_runtime_action_json(
        &serde_json::json!({
            "hasFinalizeFunction": true,
            "hasChatResponseObject": false,
            "hasExecutionObject": false,
            "hasExecutionFlowId": false,
            "hasPlanMarkers": true,
            "hasBackendPlan": true,
            "backendKind": "vision_analysis"
        })
        .to_string(),
    )
    .expect("handler runtime action plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(
        parsed["action"],
        serde_json::json!("unsupported_backend_plan_kind")
    );
    assert_eq!(parsed["backendKind"], serde_json::json!("vision_analysis"));
}

#[test]
fn plans_servertool_execution_branch_via_servertool_core_bridge() {
    let cli_projection = plan_servertool_execution_branch_json(
        &serde_json::json!({
            "executableToolCalls": [
                {
                    "id": " call_cli_1 ",
                    "name": " servertool_fixture ",
                    "executionMode": "client_exec_cli_projection"
                }
            ],
            "executedToolCallsLen": 0
        })
        .to_string(),
    )
    .expect("execution branch cli projection plan");
    let cli_projection_value: serde_json::Value =
        serde_json::from_str(&cli_projection).expect("parse cli projection plan");
    assert_eq!(
        cli_projection_value["action"],
        serde_json::json!("client_exec_cli_projection")
    );
    assert_eq!(
        cli_projection_value["projectedToolCallId"],
        serde_json::json!("call_cli_1")
    );
    assert_eq!(
        cli_projection_value["projectedToolCallIndex"],
        serde_json::json!(0)
    );

    let resolve_outcome = plan_servertool_execution_branch_json(
        &serde_json::json!({
            "executableToolCalls": [],
            "executedToolCallsLen": 1
        })
        .to_string(),
    )
    .expect("execution branch outcome plan");
    let resolve_outcome_value: serde_json::Value =
        serde_json::from_str(&resolve_outcome).expect("parse outcome plan");
    assert_eq!(
        resolve_outcome_value["action"],
        serde_json::json!("resolve_execution_outcome")
    );
}

#[test]
fn plans_servertool_engine_preflight_via_servertool_core_bridge() {
    let synthetic = plan_servertool_engine_preflight_json(
        &serde_json::json!({
            "hasSyntheticControlText": true,
            "stopSignalObserved": true,
            "stoplessDisabledOnDirectRoute": true
        })
        .to_string(),
    )
    .expect("engine preflight synthetic plan");
    let synthetic_value: serde_json::Value =
        serde_json::from_str(&synthetic).expect("parse synthetic plan");
    assert_eq!(
        synthetic_value["action"],
        serde_json::json!("return_original_chat")
    );

    let direct = plan_servertool_engine_preflight_json(
        &serde_json::json!({
            "hasSyntheticControlText": false,
            "stopSignalObserved": true,
            "stoplessDisabledOnDirectRoute": true
        })
        .to_string(),
    )
    .expect("engine preflight direct plan");
    let direct_value: serde_json::Value = serde_json::from_str(&direct).expect("parse direct plan");
    assert_eq!(
        direct_value["action"],
        serde_json::json!("return_original_chat_direct_passthrough")
    );
}

#[test]
fn plans_servertool_engine_skip_via_servertool_core_bridge() {
    let passthrough = plan_servertool_engine_skip_json(
        &serde_json::json!({
            "engineMode": "passthrough",
            "hasExecution": false
        })
        .to_string(),
    )
    .expect("engine skip passthrough plan");
    let passthrough_value: serde_json::Value =
        serde_json::from_str(&passthrough).expect("parse passthrough plan");
    assert_eq!(
        passthrough_value["action"],
        serde_json::json!("return_skipped_passthrough")
    );

    let no_execution = plan_servertool_engine_skip_json(
        &serde_json::json!({
            "engineMode": "tool_flow",
            "hasExecution": false
        })
        .to_string(),
    )
    .expect("engine skip no execution plan");
    let no_execution_value: serde_json::Value =
        serde_json::from_str(&no_execution).expect("parse no execution plan");
    assert_eq!(
        no_execution_value["action"],
        serde_json::json!("return_skipped_no_execution")
    );
}

#[test]
fn plans_servertool_execution_outcome_runtime_action_via_servertool_core_bridge() {
    let mixed = plan_servertool_execution_outcome_runtime_action_json(
        &serde_json::json!({
            "outcomeMode": "mixed_client_tools",
            "requiresPendingInjection": true,
            "followupStrategy": "pending_injection",
            "useLastExecutionFollowup": false,
            "hasLastExecutionFollowup": false,
            "hasResolvedFollowup": false,
            "hasLastExecution": false,
            "executedToolCallsLen": 0,
            "flowId": "servertool_mixed",
            "pendingSessionId": "sess_1",
            "aliasSessionIds": ["alias_1"],
            "remainingToolCallIds": ["call_2"],
            "pendingInjectionMessagesResolved": [{
                "role": "assistant"
            }]
        })
        .to_string(),
    )
    .expect("execution outcome runtime action mixed plan");
    let mixed_value: serde_json::Value = serde_json::from_str(&mixed).expect("parse mixed plan");
    assert_eq!(
        mixed_value["action"],
        serde_json::json!("return_mixed_client_tools_pending_injection")
    );
    assert_eq!(
        mixed_value["reuseLastExecutionEnvelope"],
        serde_json::json!(false)
    );
    assert_eq!(
        mixed_value["executionFlowId"],
        serde_json::json!("servertool_mixed")
    );
    assert_eq!(
        mixed_value["pendingInjection"],
        serde_json::json!({
            "sessionId": "sess_1",
            "aliasSessionIds": ["alias_1"],
            "afterToolCallIds": ["call_2"],
            "messages": [{
                "role": "assistant"
            }]
        })
    );

    let missing = plan_servertool_execution_outcome_runtime_action_json(
        &serde_json::json!({
            "outcomeMode": "servertool_only",
            "requiresPendingInjection": false,
            "followupStrategy": "generic",
            "useLastExecutionFollowup": false,
            "hasLastExecutionFollowup": false,
            "hasResolvedFollowup": false,
            "hasLastExecution": false,
            "executedToolCallsLen": 0
        })
        .to_string(),
    )
    .expect("execution outcome runtime action missing plan");
    let missing_value: serde_json::Value =
        serde_json::from_str(&missing).expect("parse missing plan");
    assert_eq!(
        missing_value["action"],
        serde_json::json!("missing_followup_contract")
    );

    let reuse = plan_servertool_execution_outcome_runtime_action_json(
        &serde_json::json!({
            "outcomeMode": "servertool_only",
            "requiresPendingInjection": false,
            "followupStrategy": "reuse_last_execution",
            "useLastExecutionFollowup": true,
            "hasLastExecutionFollowup": true,
            "hasResolvedFollowup": true,
            "hasLastExecution": true,
            "executedToolCallsLen": 1,
            "flowId": "servertool_multi",
            "lastExecution": {
                "flowId": "flow_1",
                "followup": {
                    "requestIdSuffix": ":reuse"
                },
                "context": {
                    "kept": true
                }
            },
            "resolvedFollowup": {
                "requestIdSuffix": ":resolved"
            }
        })
        .to_string(),
    )
    .expect("execution outcome runtime action reuse plan");
    let reuse_value: serde_json::Value = serde_json::from_str(&reuse).expect("parse reuse plan");
    assert_eq!(
        reuse_value["action"],
        serde_json::json!("reuse_last_execution_followup")
    );
    assert_eq!(
        reuse_value["reuseLastExecutionEnvelope"],
        serde_json::json!(true)
    );
    assert_eq!(
        reuse_value["executionFlowId"],
        serde_json::json!("servertool_multi")
    );
    assert_eq!(
        reuse_value["selectedFollowup"],
        serde_json::json!({
            "requestIdSuffix": ":reuse"
        })
    );
    assert_eq!(
        reuse_value["selectedExecutionEnvelope"],
        serde_json::json!({
            "flowId": "flow_1",
            "followup": {
                "requestIdSuffix": ":reuse"
            },
            "context": {
                "kept": true
            }
        })
    );
}

#[test]
fn plans_servertool_execution_loop_runtime_action_via_servertool_core_bridge() {
    let skip = plan_servertool_execution_loop_runtime_action_json(
        &serde_json::json!({
            "hasHandlerEntry": false,
            "hasMaterializedResult": false,
            "hasHandlerError": false
        })
        .to_string(),
    )
    .expect("execution loop runtime action skip plan");
    let skip_value: serde_json::Value = serde_json::from_str(&skip).expect("parse skip plan");
    assert_eq!(
        skip_value["action"],
        serde_json::json!("skip_non_tool_call_handler")
    );

    let apply_error = plan_servertool_execution_loop_runtime_action_json(
        &serde_json::json!({
            "hasHandlerEntry": true,
            "triggerMode": "tool_call",
            "hasMaterializedResult": false,
            "hasHandlerError": true
        })
        .to_string(),
    )
    .expect("execution loop runtime action error plan");
    let apply_error_value: serde_json::Value =
        serde_json::from_str(&apply_error).expect("parse error plan");
    assert_eq!(
        apply_error_value["action"],
        serde_json::json!("apply_handler_error_tool_output")
    );
}

#[test]
fn plans_servertool_execution_loop_effect_via_servertool_core_bridge() {
    let handler_error = plan_servertool_execution_loop_effect_json(
        &serde_json::json!({
            "mode": "handler_error",
            "toolCall": {
                "id": "call_fail_1",
                "name": "web_search",
                "arguments": "{}",
                "executionMode": "guarded",
                "stripAfterExecute": true
            }
        })
        .to_string(),
    )
    .expect("execution loop effect handler_error plan");
    let handler_error_value: serde_json::Value =
        serde_json::from_str(&handler_error).expect("parse handler_error plan");
    assert_eq!(
        handler_error_value["execution"]["flowId"],
        serde_json::json!("web_search_error")
    );
    assert_eq!(
        handler_error_value["toolCall"]["executionMode"],
        serde_json::json!("guarded")
    );

    let noop = plan_servertool_execution_loop_effect_json(
        &serde_json::json!({
            "mode": "noop",
            "toolCall": {
                "id": "call_continue_1",
                "name": "continue_execution",
                "arguments": "{}",
                "executionMode": "guarded",
                "stripAfterExecute": false
            },
            "noopFlowId": "continue_execution_flow",
            "noopFollowup": {
                "requestIdSuffix": ":continue_execution_followup"
            }
        })
        .to_string(),
    )
    .expect("execution loop effect noop plan");
    let noop_value: serde_json::Value = serde_json::from_str(&noop).expect("parse noop plan");
    assert_eq!(
        noop_value["toolCall"]["executionMode"],
        serde_json::json!("noop")
    );
    assert_eq!(
        noop_value["toolCall"]["stripAfterExecute"],
        serde_json::json!(true)
    );
    assert_eq!(
        noop_value["execution"]["flowId"],
        serde_json::json!("continue_execution_flow")
    );
}

#[test]
fn plans_servertool_response_stage_runtime_action_via_servertool_core_bridge() {
    let bypass = plan_servertool_response_stage_runtime_action_json(
        &serde_json::json!({
            "responseStageNextAction": "bypass",
            "autoHookEvaluated": false,
            "hasAutoHookResult": false,
            "responseHookRequired": false
        })
        .to_string(),
    )
    .expect("response-stage runtime action bypass plan");
    let bypass_value: serde_json::Value = serde_json::from_str(&bypass).expect("parse bypass plan");
    assert_eq!(
        bypass_value["action"],
        serde_json::json!("return_passthrough_bypass")
    );

    let run_auto_hooks = plan_servertool_response_stage_runtime_action_json(
        &serde_json::json!({
            "responseStageNextAction": "run_auto_hooks",
            "autoHookEvaluated": false,
            "hasAutoHookResult": false,
            "responseHookRequired": false
        })
        .to_string(),
    )
    .expect("response-stage runtime action pre-auto-hook plan");
    let run_auto_hooks_value: serde_json::Value =
        serde_json::from_str(&run_auto_hooks).expect("parse pre-auto-hook plan");
    assert_eq!(
        run_auto_hooks_value["action"],
        serde_json::json!("run_auto_hooks")
    );

    let passthrough = plan_servertool_response_stage_runtime_action_json(
        &serde_json::json!({
            "responseStageNextAction": "run_auto_hooks",
            "autoHookEvaluated": true,
            "hasAutoHookResult": false,
            "responseHookRequired": false
        })
        .to_string(),
    )
    .expect("response-stage runtime action passthrough plan");
    let passthrough_value: serde_json::Value =
        serde_json::from_str(&passthrough).expect("parse passthrough plan");
    assert_eq!(
        passthrough_value["action"],
        serde_json::json!("return_passthrough_no_auto_hook_result")
    );

    let required_empty = plan_servertool_response_stage_runtime_action_json(
        &serde_json::json!({
            "responseStageNextAction": "run_auto_hooks",
            "autoHookEvaluated": true,
            "hasAutoHookResult": false,
            "responseHookRequired": true
        })
        .to_string(),
    )
    .expect("response-stage runtime action required hook empty plan");
    let required_empty_value: serde_json::Value =
        serde_json::from_str(&required_empty).expect("parse required hook empty plan");
    assert_eq!(
        required_empty_value["action"],
        serde_json::json!("return_passthrough_no_auto_hook_result")
    );
}

#[test]
fn plans_servertool_registry_actions_via_servertool_core_bridge() {
    let builtin = plan_servertool_registry_registration_action_json(
        &serde_json::json!({
            "name": " stop_message_auto ",
            "hasHandler": true,
            "builtinNameMatched": true,
            "builtinEntryPresent": true,
            "registrationAllowedByConfig": true
        })
        .to_string(),
    )
    .expect("registry builtin registration plan");
    let builtin_value: serde_json::Value =
        serde_json::from_str(&builtin).expect("parse builtin registration plan");
    assert_eq!(
        builtin_value["action"],
        serde_json::json!("ignore_builtin_override")
    );
    assert_eq!(
        builtin_value["canonicalName"],
        serde_json::json!("stop_message_auto")
    );

    let adhoc = plan_servertool_registry_registration_action_json(
        &serde_json::json!({
            "name": " custom_tool ",
            "hasHandler": true,
            "builtinNameMatched": false,
            "builtinEntryPresent": false,
            "registrationAllowedByConfig": true
        })
        .to_string(),
    )
    .expect("registry adhoc registration plan");
    let adhoc_value: serde_json::Value =
        serde_json::from_str(&adhoc).expect("parse adhoc registration plan");
    assert_eq!(adhoc_value["action"], serde_json::json!("register_adhoc"));
    assert_eq!(
        adhoc_value["canonicalName"],
        serde_json::json!("custom_tool")
    );

    let lookup = plan_servertool_registry_lookup_action_json(
        &serde_json::json!({
            "name": "custom_tool",
            "builtinEntryPresent": false,
            "adHocEntryPresent": true
        })
        .to_string(),
    )
    .expect("registry lookup plan");
    let lookup_value: serde_json::Value =
        serde_json::from_str(&lookup).expect("parse registry lookup plan");
    assert_eq!(lookup_value["action"], serde_json::json!("return_adhoc"));
    assert_eq!(
        lookup_value["canonicalName"],
        serde_json::json!("custom_tool")
    );

    let auto_hooks = plan_servertool_registry_auto_hook_descriptors_json(
        &serde_json::json!([
            {
                "id": " stop_message_auto ",
                "phase": "post",
                "priority": 999,
                "order": 7
            },
            {
                "id": "vision_auto",
                "phase": "invalid"
            }
        ])
        .to_string(),
    )
    .expect("registry auto hook descriptors plan");
    let auto_hooks_value: serde_json::Value =
        serde_json::from_str(&auto_hooks).expect("parse auto hook descriptors plan");
    assert_eq!(
        auto_hooks_value[0]["id"],
        serde_json::json!("stop_message_auto")
    );
    assert_eq!(auto_hooks_value[0]["phase"], serde_json::json!("post"));
    assert_eq!(auto_hooks_value[1]["id"], serde_json::json!("vision_auto"));
    assert_eq!(auto_hooks_value[1]["phase"], serde_json::json!("default"));

    let projection = plan_servertool_registry_projection_json(
        &serde_json::json!({
            "registeredNames": [" stop_message_auto ", "vision_auto", "stop_message_auto"],
            "registeredRecords": [
                { "name": "vision_auto", "trigger": "auto", "sourceIndex": 0 },
                { "name": " custom_tool ", "trigger": "tool_call", "sourceIndex": 1 },
                { "name": "stop_message_auto", "trigger": "auto", "sourceIndex": 2 }
            ],
            "autoHandlerNames": ["vision_auto", " stop_message_auto "]
        })
        .to_string(),
    )
    .expect("registry projection plan");
    let projection_value: serde_json::Value =
        serde_json::from_str(&projection).expect("parse registry projection plan");
    assert_eq!(
        projection_value["registeredNames"],
        serde_json::json!(["stop_message_auto", "vision_auto"])
    );
    assert_eq!(
        projection_value["registeredRecords"][0],
        serde_json::json!({ "name": "custom_tool", "trigger": "tool_call", "sourceIndex": 1 })
    );
    assert_eq!(
        projection_value["autoHandlerNames"],
        serde_json::json!(["vision_auto", "stop_message_auto"])
    );

    let source_projection = plan_servertool_registry_source_projection_json(
        &serde_json::json!({
            "builtinNames": [" stop_message_auto "],
            "adHocNames": ["custom_tool", "stop_message_auto"],
            "builtinAutoHandlerNames": ["stop_message_auto"],
            "adHocAutoHandlerNames": ["custom_auto"],
            "builtinRecords": [
                { "name": "stop_message_auto", "trigger": "auto" }
            ],
            "adHocRecords": [
                { "name": "custom_tool", "trigger": "tool_call" },
                { "name": "custom_auto", "trigger": "auto" }
            ]
        })
        .to_string(),
    )
    .expect("registry source projection plan");
    let source_projection_value: serde_json::Value =
        serde_json::from_str(&source_projection).expect("parse registry source projection plan");
    assert_eq!(
        source_projection_value["registeredNames"],
        serde_json::json!(["custom_tool", "stop_message_auto"])
    );
    assert_eq!(
        source_projection_value["autoHandlerRefs"][0],
        serde_json::json!({ "name": "stop_message_auto", "source": "builtin", "sourceIndex": 0 })
    );
    assert_eq!(
        source_projection_value["registeredRecordRefs"][0],
        serde_json::json!({ "name": "custom_tool", "trigger": "tool_call", "source": "adhoc", "sourceIndex": 0 })
    );
}

#[test]
fn plans_servertool_engine_runtime_action_via_servertool_core_bridge() {
    let pending = plan_servertool_engine_runtime_action_json(
        &serde_json::json!({
            "hasPendingInjection": true,
            "isStopMessageFlow": true,
            "hasServertoolCliProjectionContext": true,
            "stoplessAction": "terminal_final"
        })
        .to_string(),
    )
    .expect("engine runtime action pending plan");
    let pending_value: serde_json::Value =
        serde_json::from_str(&pending).expect("parse pending plan");
    assert_eq!(
        pending_value["action"],
        serde_json::json!("persist_pending_injection_and_return")
    );

    let cli_projection = plan_servertool_engine_runtime_action_json(
        &serde_json::json!({
            "hasPendingInjection": false,
            "isStopMessageFlow": false,
            "hasServertoolCliProjectionContext": true,
            "stoplessAction": "continue"
        })
        .to_string(),
    )
    .expect("engine runtime action cli projection plan");
    let cli_projection_value: serde_json::Value =
        serde_json::from_str(&cli_projection).expect("parse cli projection plan");
    assert_eq!(
        cli_projection_value["action"],
        serde_json::json!("return_servertool_cli_projection_final")
    );

    let stopless_cli = plan_servertool_engine_runtime_action_json(
        &serde_json::json!({
            "hasPendingInjection": false,
            "isStopMessageFlow": true,
            "hasServertoolCliProjectionContext": false,
            "stoplessAction": "cli_projection"
        })
        .to_string(),
    )
    .expect("engine runtime action stopless cli plan");
    let stopless_cli_value: serde_json::Value =
        serde_json::from_str(&stopless_cli).expect("parse stopless cli plan");
    assert_eq!(
        stopless_cli_value["action"],
        serde_json::json!("build_stop_message_cli_projection")
    );
}

#[test]
fn plans_stopless_cli_projection_context_via_servertool_core_bridge() {
        let plan = plan_stopless_cli_projection_context_json(
            &serde_json::json!({
            "metadataWritePlan": {
                "stopless": {
                    "repeatCount": 4,
                    "maxRepeats": 6,
                    "triggerHint": " loop-hint ",
                    "schemaFeedback": {
                        "reason_code": "loop_feedback"
                    }
                }
            },
            "stoplessControl": {
                "triggerHint": "control-hint",
                "schemaFeedback": {
                    "reason_code": "control_feedback"
                }
            },
            "chatStopText": "来自 chat 的 stop 文本",
            "adapterStopText": "来自 adapter 的 stop 文本"
        })
        .to_string(),
    )
    .expect("stopless cli projection context plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(
        parsed["reasoningText"],
        serde_json::json!("来自 chat 的 stop 文本")
    );
    assert_eq!(parsed["repeatCount"], serde_json::json!(4));
    assert_eq!(parsed["maxRepeats"], serde_json::json!(6));
    assert_eq!(parsed["publicTriggerHint"], serde_json::json!("no_schema"));
    assert_eq!(
        parsed["schemaFeedback"],
        serde_json::json!({
            "reason_code": "loop_feedback"
        })
    );
}

#[test]
fn plans_servertool_execution_state_via_servertool_core_bridge() {
    let created = create_servertool_execution_loop_state_json().expect("create state");
    let created_value: serde_json::Value = serde_json::from_str(&created).expect("parse created");
    assert_eq!(created_value["executedToolCalls"], serde_json::json!([]));
    assert_eq!(created_value["executedIds"], serde_json::json!([]));

    let appended = append_servertool_executed_record_json(
        &serde_json::json!({
            "state": serde_json::from_str::<serde_json::Value>(&created).expect("created json"),
            "toolCall": {
                "id": " call_1 ",
                "name": " web_search ",
                "arguments": "{}",
                "executionMode": " backend ",
                "stripAfterExecute": true
            },
            "execution": {
                "flowId": " flow_1 ",
                "followup": { "requestIdSuffix": ":servertool_followup" }
            }
        })
        .to_string(),
    )
    .expect("append record");
    let appended_value: serde_json::Value =
        serde_json::from_str(&appended).expect("parse appended");
    assert_eq!(appended_value["executedIds"], serde_json::json!(["call_1"]));
    assert_eq!(
        appended_value["executedFlowIds"],
        serde_json::json!(["flow_1"])
    );
    assert_eq!(
        appended_value["lastExecution"]["flowId"],
        serde_json::json!("flow_1")
    );
}

#[test]
fn plans_servertool_materialization_progress_via_servertool_core_bridge() {
    let plan = plan_servertool_materialization_progress_json(
        &serde_json::json!({
            "hasFinalizeFunction": true,
            "hasChatResponseObject": false,
            "hasExecutionObject": false,
            "hasExecutionFlowId": false,
            "hasPlanMarkers": true,
            "hasBackendPlan": true
        })
        .to_string(),
    )
    .expect("materialization progress plan");
    let parsed: serde_json::Value = serde_json::from_str(&plan).expect("parse plan");
    assert_eq!(parsed["action"], "unsupported_backend_plan_kind");
}
