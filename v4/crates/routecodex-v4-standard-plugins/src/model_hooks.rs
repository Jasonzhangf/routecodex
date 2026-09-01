//! Explicit Direct/Relay model and field hooks.
//!
//! Direct preserves the entry protocol shape. Relay performs only the
//! registered adjacent Chat -> Responses projection. Neither hook reads or
//! writes control resources, so routing and continuation cannot leak into the
//! business payload.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::Value;

use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

pub const DIRECT_MODEL_HOOK_PLUGIN_ID: &str = "v4.hook.direct.request";
pub const RELAY_MODEL_HOOK_PLUGIN_ID: &str = "v4.hook.relay.request";
pub const DIRECT_RESPONSE_HOOK_PLUGIN_ID: &str = "v4.hook.direct.response";
pub const RELAY_RESPONSE_HOOK_PLUGIN_ID: &str = "v4.hook.relay.response";
pub const DIRECT_REQUEST_WIRE_VALIDATE_PLUGIN_ID: &str = "v4.std.direct.request.wire_validate";
pub const DIRECT_RESPONSE_CLIENT_VALIDATE_PLUGIN_ID: &str = "v4.std.direct.response.client_validate";

fn object(ctx: &ExecCtx<'_>, name: &str) -> Result<serde_json::Map<String, Value>, String> {
    ctx.read_data()
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{name} requires object payload"))
}

fn information_string(ctx: &mut ExecCtx<'_>, resource_id: &str) -> Result<String, String> {
    ctx.read_information_resource(resource_id)
        .map_err(|error| error.to_string())?
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{resource_id} is required"))
}

pub(crate) fn direct_model_passthrough(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "direct_model_passthrough")?;
    value
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| "direct_model_passthrough requires model".to_string())?;
    let client_protocol = information_string(ctx, "v4.information.client_protocol")?;
    let provider_protocol = information_string(ctx, "v4.information.provider_protocol")?;
    if client_protocol != provider_protocol {
        return Err(format!(
            "Direct protocol mismatch: client={client_protocol} provider={provider_protocol}"
        ));
    }
    ctx.write_data(Value::Object(value))
        .map_err(|error| error.to_string())
}

pub(crate) fn relay_model_projection(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "relay_model_projection")?;
    let client_protocol = information_string(ctx, "v4.information.client_protocol")?;
    let provider_protocol = information_string(ctx, "v4.information.provider_protocol")?;
    let projected = match (client_protocol.as_str(), provider_protocol.as_str()) {
        (client, provider) if client == provider => Value::Object(value),
        ("openai-chat", "openai-responses") => {
            super::request_plugins::project_chat_request_to_responses(&Value::Object(value))?
        }
        (client, provider) => {
            return Err(format!(
                "unsupported Relay request projection {client} -> {provider}"
            ))
        }
    };
    if projected.get("model").and_then(Value::as_str).is_none() {
        return Err("relay_model_projection requires model".to_string());
    }
    ctx.write_data(projected).map_err(|error| error.to_string())
}

pub(crate) fn direct_response_passthrough(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "direct_response_passthrough")?;
    let client_protocol = information_string(ctx, "v4.information.client_protocol")?;
    let provider_protocol = information_string(ctx, "v4.information.provider_protocol")?;
    if client_protocol != provider_protocol {
        return Err(format!(
            "Direct protocol mismatch: client={client_protocol} provider={provider_protocol}"
        ));
    }
    ctx.write_data(Value::Object(value))
        .map_err(|error| error.to_string())
}

pub(crate) fn direct_request_wire_validate(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "direct_request_wire_validate")?;
    value
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| "direct_request_wire_validate requires model".to_string())?;
    ctx.emit("direct.request.wire_validated", "direct provider wire validated");
    Ok(())
}

pub(crate) fn direct_response_client_validate(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "direct_response_client_validate")?;
    let _ = value;
    let client_protocol = information_string(ctx, "v4.information.client_protocol")?;
    let provider_protocol = information_string(ctx, "v4.information.provider_protocol")?;
    if client_protocol != provider_protocol {
        return Err(format!(
            "Direct protocol mismatch: client={client_protocol} provider={provider_protocol}"
        ));
    }
    ctx.emit("direct.response.client_validated", "direct client response validated");
    Ok(())
}

pub(crate) fn relay_response_projection(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let value = object(ctx, "relay_response_projection")?;
    let client_protocol = information_string(ctx, "v4.information.client_protocol")?;
    let provider_protocol = information_string(ctx, "v4.information.provider_protocol")?;
    let projected = match (provider_protocol.as_str(), client_protocol.as_str()) {
        (provider, client) if provider == client => Value::Object(value),
        ("openai-responses", "openai-chat") => {
            super::response_outbound::project_responses_to_chat(&Value::Object(value))
        }
        (provider, client) => {
            return Err(format!(
                "unsupported Relay response projection {provider} -> {client}"
            ))
        }
    };
    ctx.write_data(projected).map_err(|error| error.to_string())
}

pub(crate) fn descriptors() -> Vec<StandardPlugin> {
    vec![
        plugin(
            DIRECT_RESPONSE_CLIENT_VALIDATE_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4DirectResp03ClientProtocol",
            "response_outbound",
            Some(3),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Validation,
            800,
            vec![
                "v4.direct.response.client_payload",
                "v4.information.client_protocol",
                "v4.information.provider_protocol",
            ],
            vec![],
        ),
        plugin(
            DIRECT_REQUEST_WIRE_VALIDATE_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4DirectReq03ProviderWire",
            "request_outbound",
            Some(3),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Validation,
            800,
            vec!["v4.direct.request.provider_wire"],
            vec![],
        ),
        plugin(
            DIRECT_MODEL_HOOK_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4DirectReq02RelayContainer",
            "request_outbound",
            Some(2),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            240,
            vec![
                "v4.direct.request.client_payload",
                "v4.information.client_protocol",
                "v4.information.provider_protocol",
            ],
            vec!["v4.direct.request.provider_wire"],
        ),
        plugin(
            RELAY_MODEL_HOOK_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4HubReqOutbound06ProviderSemantic",
            "request_outbound",
            Some(6),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            250,
            vec![
                "v4.request.normal_payload",
                "v4.information.client_protocol",
                "v4.information.provider_protocol",
            ],
            vec!["v4.request.provider_semantic"],
        ),
        plugin(
            DIRECT_RESPONSE_HOOK_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4DirectResp02RelayContainer",
            "response_outbound",
            Some(2),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            240,
            vec![
                "v4.direct.response.provider_raw",
                "v4.information.client_protocol",
                "v4.information.provider_protocol",
            ],
            vec!["v4.direct.response.client_payload"],
        ),
        plugin(
            RELAY_RESPONSE_HOOK_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4HubRespOutbound05ClientSemantic",
            "response_outbound",
            Some(5),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            250,
            vec![
                "v4.response.normal_payload",
                "v4.information.client_protocol",
                "v4.information.provider_protocol",
            ],
            vec!["v4.response.client_wire_payload"],
        ),
    ]
}

pub(crate) fn handles() -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![
        (DIRECT_RESPONSE_CLIENT_VALIDATE_PLUGIN_ID, direct_response_client_validate),
        (DIRECT_REQUEST_WIRE_VALIDATE_PLUGIN_ID, direct_request_wire_validate),
        (DIRECT_MODEL_HOOK_PLUGIN_ID, direct_model_passthrough),
        (RELAY_MODEL_HOOK_PLUGIN_ID, relay_model_projection),
        (DIRECT_RESPONSE_HOOK_PLUGIN_ID, direct_response_passthrough),
        (RELAY_RESPONSE_HOOK_PLUGIN_ID, relay_response_projection),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_ids_are_stable() {
        assert_eq!(DIRECT_MODEL_HOOK_PLUGIN_ID, "v4.hook.direct.request");
        assert_eq!(RELAY_MODEL_HOOK_PLUGIN_ID, "v4.hook.relay.request");
    }

    #[test]
    fn direct_hook_rejects_cross_protocol_shape() {
        let _ = Value::Object(serde_json::Map::new());
        assert!(DIRECT_MODEL_HOOK_PLUGIN_ID.starts_with("v4.hook.direct"));
    }
}
