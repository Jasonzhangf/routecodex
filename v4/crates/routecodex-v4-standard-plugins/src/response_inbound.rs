//! V4 response inbound plugin: provider raw/semantic -> parsed response.
//!
//! This module owns the `protocol_decode` descriptor and typed handle for
//! `V4HubRespInbound02Parsed`. It only consumes the adjacent
//! `v4.response.provider_raw` resource and writes the adjacent
//! `v4.response.normal_payload` resource. It never performs response
//! governance, tool harvest, continuation save/release or provider/client
//! repair, and it never writes control/error/debug/snapshot facts into data.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::{json, Value};

use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

const PLUGIN_ID: &str = "v4.std.response.protocol_decode";

fn control_keys() -> &'static [&'static str] {
    &[
        "control",
        "error_chain",
        "route_facts",
        "target_selection",
        "payload_cycle",
        "debug",
        "diagnostics",
        "snapshot",
    ]
}

fn reject_control_fields(object: &serde_json::Map<String, Value>) -> Result<(), String> {
    for key in control_keys() {
        if object.contains_key(*key) {
            return Err(format!(
                "protocol_decode rejects control/debug field {key} in provider response"
            ));
        }
    }
    Ok(())
}

fn normalize_output(value: &Value) -> Result<Value, String> {
    let output = value
        .get("output")
        .ok_or_else(|| "protocol_decode requires provider data output".to_string())?;
    let items = output
        .as_array()
        .ok_or_else(|| "protocol_decode requires provider data output array".to_string())?;
    let normalized: Vec<Value> = items
        .iter()
        .map(|item| {
            let object = item
                .as_object()
                .ok_or_else(|| "protocol_decode requires output items to be objects".to_string())?;
            let kind = object
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| "protocol_decode requires output item type string".to_string())?;
            let mut entry = object.clone();
            entry.insert("type".to_string(), json!(kind));
            Ok(Value::Object(entry))
        })
        .collect::<Result<_, String>>()?;
    Ok(json!(normalized))
}

pub(crate) fn protocol_decode_descriptors() -> Vec<StandardPlugin> {
    vec![plugin(
        PLUGIN_ID,
        PluginCategory::Protocol,
        "V4HubRespInbound02Parsed",
        "response_inbound",
        Some(2),
        PluginKind::Operator,
        PluginEffect::Semantic,
        PluginPhase::Semantic,
        200,
        vec!["v4.response.provider_raw"],
        vec!["v4.response.normal_payload"],
    )]
}

fn protocol_decode(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let raw = data
        .as_object()
        .ok_or_else(|| "protocol_decode requires an object provider response".to_string())?;
    reject_control_fields(raw)?;

    let request_id = raw
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "protocol_decode requires string requestId".to_string())?;
    let provider_id = raw
        .get("providerId")
        .and_then(Value::as_str)
        .ok_or_else(|| "protocol_decode requires string providerId".to_string())?;
    let status_code = raw
        .get("statusCode")
        .and_then(Value::as_u64)
        .ok_or_else(|| "protocol_decode requires numeric statusCode".to_string())?;
    if status_code < 200 || status_code >= 300 {
        return Err(format!(
            "protocol_decode rejects non-success provider status {status_code}"
        ));
    }

    let provider_data = raw
        .get("data")
        .ok_or_else(|| "protocol_decode requires provider data object".to_string())?;
    let provider_data_object = provider_data
        .as_object()
        .ok_or_else(|| "protocol_decode requires provider data object".to_string())?;

    let mut parsed = provider_data_object.clone();
    parsed.insert("requestId".to_string(), json!(request_id));
    parsed.insert("providerId".to_string(), json!(provider_id));
    parsed.insert("statusCode".to_string(), json!(status_code));
    parsed.insert("output".to_string(), normalize_output(provider_data)?);
    ctx.write_data(Value::Object(parsed))
        .map_err(|error| error.to_string())
}

pub(crate) fn protocol_decode_handle() -> (&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)
{
    (
        PLUGIN_ID,
        protocol_decode as fn(&mut ExecCtx<'_>) -> Result<(), String>,
    )
}

pub(crate) fn response_inbound_handles(
) -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![protocol_decode_handle()]
}
