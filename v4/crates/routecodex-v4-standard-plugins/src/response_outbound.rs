use serde_json::{json, Value};

use routecodex_v4_cordis_bridge::ExecCtx;

fn object_payload<'a>(
    value: &'a Value,
    operation: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{operation} requires an object payload"))?;
    Ok(object)
}

/// Project governed normal response data into client semantic data.
pub fn client_semantic_projection(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let object = object_payload(data, "client_semantic_projection")?;
    let parsed = object
        .get("parsed_response")
        .and_then(Value::as_object)
        .ok_or_else(|| "client_semantic_projection requires parsed_response object".to_string())?;
    ctx.write_data(json!({"client_semantic": parsed}))
        .map_err(|error| error.to_string())
}

/// Validate the semantic-to-SSE boundary without transporting frame state.
pub fn sse_frame_boundary(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = object_payload(ctx.read_data(), "sse_frame_boundary")?;
    if data.get("client_semantic").is_none() {
        return Err("sse_frame_boundary requires client_semantic from previous node".to_string());
    }
    ctx.emit(
        "node.client_sse_frame_validated",
        "client SSE frame boundary validated",
    );
    Ok(())
}

/// Build the terminal client frame from client semantic response data.
pub fn frame_build(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = object_payload(ctx.read_data(), "frame_build")?;
    let semantic = data
        .get("client_semantic")
        .and_then(Value::as_object)
        .ok_or_else(|| "frame_build requires client_semantic object".to_string())?;
    ctx.write_data(json!({"frame": semantic}))
        .map_err(|error| error.to_string())
}
