//! Followup helper blocks — thin wrappers around followup-core.
//! NAPI entry points are in lib.rs.

use followup_core::{
    build_followup_request_id, decide_budget_reset, inject_loop_warning, LoopWarningInput,
};

pub fn build_request_id(base: &str, suffix: Option<&str>) -> String {
    build_followup_request_id(base, suffix)
}

pub fn inject_warning(input: LoopWarningInput) -> Vec<followup_core::Message> {
    inject_loop_warning(input)
}

pub fn budget_reset(
    stop_observed: bool,
    stop_eligible: bool,
    current_used: u32,
) -> followup_core::BudgetResetDecision {
    decide_budget_reset(stop_observed, stop_eligible, current_used)
}
