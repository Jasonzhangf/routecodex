use serde_json::json;

use routecodex_v4_cordis_bridge::ExecCtx;

/// Decode provider raw response at the response-inbound node boundary.
pub fn protocol_decode(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    if !data.is_string() {
        return Err("protocol_decode requires provider raw string".to_string());
    }
    let raw = data.as_str().unwrap_or("");
    if raw.trim_start().is_empty() {
        return Err("protocol_decode rejects empty provider raw".to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| format!("protocol_decode rejects malformed provider raw: {error}"))?;
    if !parsed.is_object() {
        return Err("protocol_decode requires provider raw JSON object".to_string());
    }
    ctx.write_data(json!({"parsed_response": parsed}))
        .map_err(|error| error.to_string())
}
