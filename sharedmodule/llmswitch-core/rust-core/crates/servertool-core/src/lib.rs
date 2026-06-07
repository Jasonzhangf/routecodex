//! Servertool core — pure Rust shared library for servertool orchestration.
//!
//! Modules:
//! - `stop_gateway_context`: finish_reason analysis and stop eligibility
//! - `stop_message_loop_guard`: loop guard evaluation
//! - `stop_message_counter`: budget counter logic
//! - `cli_contract`: servertool binary input/output contract

pub mod cli_contract;
pub mod outcome_contract;
pub mod tool_name_projection;
pub mod stop_gateway_context;
pub mod stop_message_counter;
pub mod stop_message_loop_guard;
