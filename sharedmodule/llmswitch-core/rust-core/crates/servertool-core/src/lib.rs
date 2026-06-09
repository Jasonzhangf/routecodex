//! Servertool core — pure Rust shared library for servertool orchestration.
//!
//! Modules:
//! - `stop_gateway_context`: finish_reason analysis and stop eligibility
//! - `stop_message_loop_guard`: loop guard evaluation
//! - `stop_message_counter`: budget counter logic
//! - `cli_contract`: servertool binary input/output contract
//! - `backend_route_contract`: backend-route outcome policy contract

pub mod backend_route_contract;
pub mod blocked_report_contract;
pub mod cli_contract;
pub mod cli_result_guard;
pub mod engine_selection_contract;
pub mod loop_state_contract;
pub mod orchestration_policy_contract;
pub mod outcome_contract;
pub mod pending_session_contract;
pub mod persisted_lookup;
pub mod pre_command_hook_contract;
pub mod stop_gateway_context;
pub mod stop_message_compare_context;
pub mod stop_message_counter;
pub mod stop_message_default_config;
pub mod stop_message_loop_guard;
pub mod stop_message_persist_plan;
pub mod stop_visible_text;
pub mod stopless_decision_context_goal;
pub mod stopless_decision_context_signals;
pub mod stopless_goal_state_contract;
pub mod stopless_learned_note_contract;
pub mod stopless_orchestration_contract;
pub mod text_extraction;
