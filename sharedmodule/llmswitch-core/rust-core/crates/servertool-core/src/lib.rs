//! Servertool core — pure Rust shared library for servertool orchestration.
//!
//! Modules:
//! - `stop_gateway_context`: finish_reason analysis and stop eligibility
//! - `stop_message_loop_guard`: loop guard evaluation
//! - `stop_message_counter`: budget counter logic
//! - `cli_contract`: servertool binary input/output contract
//! - `backend_route_contract`: backend-route outcome policy contract

pub mod backend_route_contract;
pub mod cli_contract;
pub mod cli_result_guard;
pub mod loop_state_contract;
pub mod orchestration_policy_contract;
pub mod outcome_contract;
pub mod pending_session_contract;
pub mod persisted_lookup;
pub mod stop_gateway_context;
pub mod stop_message_compare_context;
pub mod stop_message_counter;
pub mod stop_message_loop_guard;
pub mod stop_visible_text;
pub mod text_extraction;
pub mod tool_name_projection;
