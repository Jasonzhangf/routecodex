//! Stop-message decision block — thin wrapper around stop-message-core.
//! This module does NOT expose NAPI directly. The NAPI entry point is in `lib.rs`.

use stop_message_core::{decide, StopMessageDecision, StopMessageDecisionContext};

pub fn decide_stop_message_action(ctx: &StopMessageDecisionContext) -> StopMessageDecision {
    decide(ctx)
}
