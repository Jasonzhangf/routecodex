//! V4 response outbound plugins: governed response -> client semantic -> frame.
//!
//! This module owns the `client_semantic_projection` and `frame_build`
//! descriptors/handles for `V4HubRespOutbound04ClientSemantic` and
//! `V4ServerRespOutbound06ClientFrame`. It only performs adjacent response
//! projection; it does not implement continuation save/release, SSE framing,
//! provider-specific repair, tool harvest or response governance.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::{json, Value};

use super::response_inbound::reject_control_fields;
use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

const CLIENT_SEMANTIC_ID: &str = "v4.std.response.client_semantic_projection";
const FRAME_BUILD_ID: &str = "v4.std.response.frame_build";

pub(crate) fn response_outbound_descriptors() -> Vec<StandardPlugin> {
    vec![
        plugin(
            CLIENT_SEMANTIC_ID,
            PluginCategory::Protocol,
            "V4HubRespOutbound04ClientSemantic",
            "response_outbound",
            Some(4),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            300,
            vec!["v4.response.normal_payload"],
            vec!["v4.response.client_wire_payload"],
        ),
        plugin(
            "v4.std.response.sse_frame_boundary",
            PluginCategory::Protocol,
            "V4ServerSseOut05FrameBoundary",
            "response_outbound",
            Some(5),
            PluginKind::Operator,
            PluginEffect::ReadOnly,
            PluginPhase::Projection,
            350,
            vec!["v4.response.client_wire_payload"],
            vec![],
        ),
        plugin(
            FRAME_BUILD_ID,
            PluginCategory::Protocol,
            "V4ServerRespOutbound06ClientFrame",
            "response_outbound",
            Some(6),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            400,
            vec!["v4.response.client_wire_payload"],
            vec!["v4.response.client_object"],
        ),
    ]
}

fn client_semantic_projection(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let governed = data
        .as_object()
        .ok_or_else(|| "client_semantic_projection requires an object response".to_string())?;
    governed
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "client_semantic_projection requires string requestId".to_string())?;

    reject_control_fields(governed)?;
    let mut semantic = governed.clone();
    semantic.remove("providerId");
    semantic.remove("statusCode");
    semantic.remove("semantic");
    semantic.remove("governance");
    ctx.write_data(Value::Object(semantic))
        .map_err(|error| error.to_string())
}

fn frame_build(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let semantic = data
        .as_object()
        .ok_or_else(|| "frame_build requires an object client semantic".to_string())?;

    let request_id = semantic
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "frame_build requires string requestId".to_string())?;
    let mut response = semantic.clone();
    response.remove("requestId");
    reject_control_fields(&response)?;
    let frame = json!({
        "kind": "client_frame",
        "requestId": request_id,
        "response": response
    });
    ctx.write_data(frame).map_err(|error| error.to_string())
}

fn sse_frame_boundary(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let wire = data
        .as_object()
        .ok_or_else(|| "sse_frame_boundary requires an object client wire payload".to_string())?;
    reject_control_fields(wire)?;
    wire.get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "sse_frame_boundary requires string requestId".to_string())?;
    Ok(())
}

pub(crate) fn client_semantic_projection_handle(
) -> (&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>) {
    (
        CLIENT_SEMANTIC_ID,
        client_semantic_projection as fn(&mut ExecCtx<'_>) -> Result<(), String>,
    )
}

pub(crate) fn frame_build_handle() -> (&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>) {
    (
        FRAME_BUILD_ID,
        frame_build as fn(&mut ExecCtx<'_>) -> Result<(), String>,
    )
}

pub(crate) fn response_outbound_handles(
) -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![
        client_semantic_projection_handle(),
        (
            "v4.std.response.sse_frame_boundary",
            sse_frame_boundary as fn(&mut ExecCtx<'_>) -> Result<(), String>,
        ),
        frame_build_handle(),
    ]
}
