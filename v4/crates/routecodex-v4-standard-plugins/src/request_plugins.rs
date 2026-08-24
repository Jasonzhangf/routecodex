//! Request-side P0 plugins.  Each handler owns one adjacent semantic step;
//! no handler reads control state or performs production dispatch.
//! The request lane remains independently executable until integration opens.
//! Its candidate boundary is fixed before any production dispatcher wiring.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::{json, Map, Value};

use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

const CONTROL_KEYS: &[&str] = &[
    "control", "metadata_center", "error_chain", "route_facts",
    "target_selection", "debug", "diagnostics", "snapshot", "providerId",
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

fn request_normalize(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "request_normalize")?;
    reject_control(&object)?;
    object.get("requestId").and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "request_normalize requires requestId".to_string())?;
    object.get("input").or_else(|| object.get("messages"))
        .ok_or_else(|| "request_normalize requires input or messages".to_string())?;
    let _ = object;
    Ok(())
}

fn chat_to_responses(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "chat_to_responses")?;
    reject_control(&object)?;
    let messages = object.get("messages").and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "chat_to_responses requires messages array".to_string())?;
    let mut projected = object;
    projected.remove("messages");
    projected.insert("input".to_string(), Value::Array(messages));
    projected.insert("protocol".to_string(), json!("responses"));
    ctx.write_data(Value::Object(projected)).map_err(|error| error.to_string())
}

fn request_governance(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "request_governance")?;
    reject_control(&object)?;
    if let Some(tools) = object.get("tools") {
        if !tools.is_array() { return Err("request_governance requires tools array".to_string()); }
    }
    ctx.write_data(Value::Object(object)).map_err(|error| error.to_string())
}

fn provider_semantic(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "provider_semantic")?;
    reject_control(&object)?;
    let model = object.get("model").and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider_semantic requires model".to_string())?;
    let input = object.get("input").cloned()
        .ok_or_else(|| "provider_semantic requires input".to_string())?;
    ctx.write_data(json!({"model": model, "input": input, "protocol": "responses"}))
        .map_err(|error| error.to_string())
}

fn wire_build(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "wire_build")?;
    reject_control(&object)?;
    let model = object.get("model").and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "wire_build requires model".to_string())?;
    let input = object.get("input").cloned()
        .ok_or_else(|| "wire_build requires input".to_string())?;
    ctx.write_data(json!({"model": model, "input": input}))
        .map_err(|error| error.to_string())
}

pub(crate) fn descriptors() -> Vec<StandardPlugin> {
    vec![
        plugin(
            "v4.std.request.responses_normalize",
            PluginCategory::Protocol,
            "V4HubReqInbound03Normalized",
            "request_inbound",
            Some(3),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Semantic,
            100,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
        plugin(
            "v4.std.request.chat_to_responses",
            PluginCategory::Protocol,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            200,
            vec!["v4.request.normal_payload"],
            vec!["v4.request.normal_payload"],
        ),
        plugin(
            "v4.std.request.governance",
            PluginCategory::ChatProcess,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            300,
            vec!["v4.request.normal_payload"],
            vec!["v4.request.normal_payload"],
        ),
        plugin(
            "v4.std.request.provider_semantic",
            PluginCategory::Provider,
            "V4HubReqOutbound05ProviderSemantic",
            "request_outbound",
            Some(5),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            100,
            vec!["v4.request.normal_payload"],
            vec!["v4.request.provider_semantic"],
        ),
        plugin(
            "v4.std.request.responses_wire_build",
            PluginCategory::Protocol,
            "V4ProviderReqCompat06Compat",
            "request_outbound",
            Some(6),
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
        ("v4.std.request.responses_normalize", request_normalize),
        ("v4.std.request.chat_to_responses", chat_to_responses),
        ("v4.std.request.governance", request_governance),
        ("v4.std.request.provider_semantic", provider_semantic),
        ("v4.std.request.responses_wire_build", wire_build),
    ]
}
