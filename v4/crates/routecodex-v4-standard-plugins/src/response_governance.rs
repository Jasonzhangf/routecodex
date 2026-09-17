use routecodex_v4_cordis_bridge::ExecCtx;

// Response governance owns validation/harvest/projection entry boundaries;
// each operation still delegates to its single existing semantic owner.
pub fn response_governance_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::response_governance(ctx)
}

pub fn response_tool_harvest_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::tool_harvest(ctx)
}
