//! Servertool core — pure Rust shared library for servertool orchestration.
//!
//! Modules:
//! - `stop_gateway_context`: finish_reason analysis and stop eligibility
//! - `stop_message_loop_guard`: loop guard evaluation
//! - `stop_message_counter`: budget counter logic
//! - `cli_contract`: servertool binary input/output contract
//! - `backend_route_contract`: backend-route outcome policy contract

pub mod auto_hook_execution_contract;
pub mod auto_hook_queue_contract;
pub mod backend_route_contract;
pub mod blocked_report_contract;
pub mod cli_contract;
pub mod cli_result_guard;
pub mod engine_preflight_contract;
pub mod engine_runtime_action_contract;
pub mod engine_selection_contract;
pub mod engine_skip_contract;
pub mod execution_branch_contract;
pub mod execution_dispatch_contract;
pub mod execution_handler_contract;
pub mod execution_loop_effect_contract;
pub mod execution_loop_runtime_action_contract;
pub mod execution_outcome_runtime_action_contract;
pub mod execution_state_contract;
pub mod hook_skeleton_contract;
pub mod loop_state_contract;
pub mod orchestration_policy_contract;
pub mod outcome_contract;
pub mod pending_session_contract;
pub mod persisted_lookup;
pub mod pre_command_hook_contract;
pub mod registry_contract;
pub mod response_stage_runtime_action_contract;
pub mod server_side_tool_entry_contract;
pub mod stop_gateway_context;
pub mod stop_message_compare_context;
pub mod stop_message_counter;
pub mod stop_message_default_config;
pub mod stop_message_loop_guard;
pub mod stop_message_auto_handler;
pub mod stop_message_persist_plan;
pub mod stop_visible_text;
pub mod stopless_cli_projection_context_contract;
pub mod stopless_decision_context_signals;
pub mod stopless_learned_note_contract;
pub mod stopless_orchestration_contract;
pub mod stopless_prompt;
pub mod text_extraction;
