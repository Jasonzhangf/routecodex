use routecodex_v4_cordis_bridge::ExecCtx;

pub(crate) fn request_normalize_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::request_plugins::request_normalize(ctx)
}
