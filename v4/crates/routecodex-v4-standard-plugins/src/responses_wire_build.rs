use routecodex_v4_cordis_bridge::ExecCtx;

pub(crate) fn responses_wire_build_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::request_plugins::wire_build(ctx)
}
