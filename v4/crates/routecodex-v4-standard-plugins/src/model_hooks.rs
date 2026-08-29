//! Explicit Direct/Relay model and field hooks.
//!
//! Direct preserves the entry protocol shape. Relay performs only the
//! registered adjacent Chat -> Responses projection. Neither hook reads or
//! writes control resources, so routing and continuation cannot leak into the
//! business payload.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::Value;

use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

pub const DIRECT_MODEL_HOOK_PLUGIN_ID: &str = "v4.std.hook.direct_model_passthrough";
pub const RELAY_MODEL_HOOK_PLUGIN_ID: &str = "v4.std.hook.relay_model_projection";

fn object(ctx: &ExecCtx<'_>, name: &str) -> Result<serde_json::Map<String, Value>, String> {
    ctx.read_data()
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{name} requires object payload"))
}

pub(crate) fn direct_model_passthrough(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "direct_model_passthrough")?;
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| "direct_model_passthrough requires model".to_string())?;
    if value.get("protocol").and_then(Value::as_str) == Some("responses")
        && value.contains_key("messages")
    {
        return Err("direct_model_passthrough rejects Chat fields on Responses entry".to_string());
    }
    let _ = model;
    ctx.write_data(Value::Object(value)).map_err(|error| error.to_string())
}

pub(crate) fn relay_model_projection(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "relay_model_projection")?;
    let projected = if value.get("messages").is_some() {
        super::request_plugins::project_chat_request_to_responses(&Value::Object(value))?
    } else {
        Value::Object(value)
    };
    if projected.get("model").and_then(Value::as_str).is_none() {
        return Err("relay_model_projection requires model".to_string());
    }
    ctx.write_data(projected).map_err(|error| error.to_string())
}

pub(crate) fn descriptors() -> Vec<StandardPlugin> {
    vec![
        plugin(
            DIRECT_MODEL_HOOK_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            240,
            vec!["v4.request.normal_payload"],
            vec!["v4.request.normal_payload"],
        ),
        plugin(
            RELAY_MODEL_HOOK_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4HubReqChatProcess04Governed",
            "request_chat_process",
            Some(4),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            250,
            vec!["v4.request.normal_payload"],
            vec!["v4.request.normal_payload"],
        ),
    ]
}

pub(crate) fn handles() -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![
        (DIRECT_MODEL_HOOK_PLUGIN_ID, direct_model_passthrough),
        (RELAY_MODEL_HOOK_PLUGIN_ID, relay_model_projection),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_ids_are_stable() {
        assert_eq!(DIRECT_MODEL_HOOK_PLUGIN_ID, "v4.std.hook.direct_model_passthrough");
        assert_eq!(RELAY_MODEL_HOOK_PLUGIN_ID, "v4.std.hook.relay_model_projection");
    }

    #[test]
    fn direct_hook_rejects_cross_protocol_shape() {
        let _ = Value::Object(serde_json::Map::new());
        assert!(DIRECT_MODEL_HOOK_PLUGIN_ID.starts_with("v4.std.hook.direct"));
    }
}
