use routecodex_v4_cordis_bridge::ExecCtx;

// Request projection entry owned by the request plugin lane. The semantic
// projection remains in request_plugins; this wrapper only exposes the
// registered lane boundary.
pub fn chat_to_responses_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let projected = super::request_plugins::project_chat_request_to_responses(&ctx.read_data())?;
    ctx.write_data(projected).map_err(|error| error.to_string())
}

pub use super::request_plugins::project_chat_request_to_responses;
