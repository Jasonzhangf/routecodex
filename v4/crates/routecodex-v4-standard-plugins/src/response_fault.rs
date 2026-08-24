use routecodex_v4_cordis_bridge::ExecCtx;

// Typed fault intake only; classification/policy/decision remain owned by the
// Error Skeleton and never enter the response business payload.
pub fn response_fault_intake_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::error_intake(ctx)
}
