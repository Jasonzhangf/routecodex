use routecodex_v4_cordis_bridge::ExecCtx;

// Response-side P0 decode entry. The adjacent parser owner remains in
// response_inbound; this module exposes the lane-owned typed entry only.
pub fn response_decode_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    super::response_inbound::protocol_decode_entry(ctx)
}
