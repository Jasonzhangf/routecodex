//! Request-side P0 plugins.  Each handler owns one adjacent semantic step;
//! no handler reads control state or performs production dispatch.
//! Shared helper surface is included in the same candidate scope as its five typed entries.
//! Candidate source scope is immutable until the integration owner opens wiring.
//! Gate input closure covers each typed entry and this shared owner.
//! Boundary gate executable is part of the candidate contract.
//! The request lane remains independently executable until integration opens.
//! Its candidate boundary is fixed before any production dispatcher wiring.
//! This candidate records the request lane's current owner boundary at integration time.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::{json, Map, Value};

use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

pub const REQUEST_NORMALIZE_PLUGIN_ID: &str = "v4.std.request.responses_normalize";

const CONTROL_KEYS: &[&str] = &[
    "requestId",
    "control",
    "metadata_center",
    "error_chain",
    "route_facts",
    "target_selection",
    "debug",
    "diagnostics",
    "snapshot",
    "providerId",
];

fn reject_control(object: &Map<String, Value>) -> Result<(), String> {
    for key in CONTROL_KEYS {
        if object.contains_key(*key) {
            return Err(format!("request plugin rejects control field {key}"));
        }
    }
    Ok(())
}

fn require_object(ctx: &ExecCtx<'_>, name: &str) -> Result<Map<String, Value>, String> {
    ctx.read_data()
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{name} requires an object request"))
}

/// Protocol-owner projection used by the production request adapter.
pub fn project_chat_request_to_responses(body: &Value) -> Result<Value, String> {
    let object = body
        .as_object()
        .cloned()
        .ok_or_else(|| "Chat request must be an object".to_string())?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Chat request messages must be an array".to_string())?;
    let mut projected = object;
    projected.remove("messages");
    projected.insert("input".to_string(), Value::Array(messages));
    if let Some(max_tokens) = projected.remove("max_tokens") {
        projected.insert("max_output_tokens".to_string(), max_tokens);
    }
    if let Some(tools) = projected.get("tools").and_then(Value::as_array) {
        let projected_tools = tools
            .iter()
            .map(|tool| {
                let function = tool
                    .get("function")
                    .ok_or_else(|| "function tool body is required".to_string())?;
                Ok(json!({
                    "type": "function",
                    "name": function.get("name").cloned().unwrap_or(Value::Null),
                    "description": function.get("description").cloned().unwrap_or(Value::Null),
                    "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({}))
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;
        projected.insert("tools".to_string(), Value::Array(projected_tools));
    }
    projected.insert("protocol".to_string(), json!("responses"));
    Ok(Value::Object(projected))
}

pub(crate) fn request_normalize(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "request_normalize")?;
    reject_control(&object)?;
    object
        .get("input")
        .or_else(|| object.get("messages"))
        .ok_or_else(|| "request_normalize requires input or messages".to_string())?;
    let _ = object;
    Ok(())
}

pub(crate) fn request_governance(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "request_governance")?;
    reject_control(&object)?;
    if let Some(tools) = object.get("tools") {
        if !tools.is_array() {
            return Err("request_governance requires tools array".to_string());
        }
    }
    ctx.write_data(Value::Object(object))
        .map_err(|error| error.to_string())
}

pub(crate) fn wire_build(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "wire_build")?;
    reject_control(&object)?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "wire_build requires model".to_string())?;
    let input = object
        .get("input")
        .cloned()
        .ok_or_else(|| "wire_build requires input".to_string())?;
    ctx.write_data(json!({"model": model, "input": input}))
        .map_err(|error| error.to_string())
}

pub(crate) fn descriptors() -> Vec<StandardPlugin> {
    vec![
        plugin(
            REQUEST_NORMALIZE_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4HubReqInbound02Normalized",
            "request_inbound",
            Some(2),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Semantic,
            100,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.request.governance",
            PluginCategory::ChatProcess,
            "V4HubReqChatProcess03Governed",
            "request_chat_process",
            Some(3),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            300,
            vec!["v4.request.normal_payload"],
            vec!["v4.request.normal_payload"],
        ),
        plugin(
            "v4.std.request.responses_wire_build",
            PluginCategory::Protocol,
            "V4ProviderReqCompat07ProviderCompat",
            "request_outbound",
            Some(7),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            100,
            vec!["v4.request.provider_semantic"],
            vec!["v4.request.provider_wire_payload"],
        ),
    ]
}

pub(crate) fn handles() -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![
        (REQUEST_NORMALIZE_PLUGIN_ID, request_normalize),
        ("v4.std.request.governance", request_governance),
        ("v4.std.request.responses_wire_build", wire_build),
    ]
}
