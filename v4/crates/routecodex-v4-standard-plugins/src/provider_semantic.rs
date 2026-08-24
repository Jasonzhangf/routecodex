use routecodex_v4_cordis_bridge::ExecCtx;

pub(crate) fn provider_semantic_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::request_plugins::provider_semantic(ctx)
}
