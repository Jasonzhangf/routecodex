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
    used: u32,
    max_repeats: u32,
) -> StopSchemaGateDecision {
    evaluate_stop_schema_gate(assistant_text, used, max_repeats)
}
