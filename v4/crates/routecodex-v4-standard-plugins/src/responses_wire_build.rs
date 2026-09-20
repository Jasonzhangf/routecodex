use routecodex_v4_cordis_bridge::ExecCtx;
// Independent source lane entry; production wiring remains forbidden here.
// Candidate scope is verified independently from production dispatch.
// Gate input closure is recorded before integration.
// Boundary gate executable is part of the candidate contract.
// Wire construction is the final adjacent request step and emits no control metadata.

pub fn responses_wire_build_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::request_plugins::wire_build(ctx)
}
