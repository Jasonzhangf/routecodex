//! Stop-message decision block — thin wrapper around stop-message-core.
//! This module does NOT expose NAPI directly. The NAPI entry point is in `lib.rs`.

use stop_message_core::{
    decide, evaluate_stop_schema_gate, StopMessageDecision, StopMessageDecisionContext,
    StopSchemaGateDecision,
};

pub fn decide_stop_message_action(ctx: &StopMessageDecisionContext) -> StopMessageDecision {
    decide(ctx)
}

pub fn evaluate_stop_schema(
    assistant_text: &str,
    reasoning_stop_arguments: Option<&str>,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
) -> StopSchemaGateDecision {
    stop_message_core::evaluate_stop_schema_gate_with_reasoning_stop_arguments(
        assistant_text,
        reasoning_stop_arguments,
        used,
        max_repeats,
        prev_observation_hash,
        prev_no_change_count,
    )
}
