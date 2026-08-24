use routecodex_v4_cordis_bridge::ExecCtx;

pub(crate) fn chat_to_responses_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::request_plugins::chat_to_responses(ctx)
}
