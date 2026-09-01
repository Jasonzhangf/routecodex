//! V4 response inbound plugin: provider raw/semantic -> parsed response.
//!
//! This module owns the `protocol_decode` descriptor and typed handle for
//! `V4HubRespInbound03Normalized`. It only consumes the adjacent
//! `v4.response.provider_raw` resource and writes the adjacent
//! `v4.response.normal_payload` resource. It never performs response
//! governance, tool harvest, continuation save/release or provider/client
//! repair, and it never writes control/error/debug/snapshot facts into data.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::{json, Value};

use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

const PLUGIN_ID: &str = "v4.std.response.protocol_decode";
const PROVIDER_COMPAT_PLUGIN_ID: &str = "v4.std.response.provider_compat";
const PROVIDER_RAW_VALIDATE_PLUGIN_ID: &str = "v4.std.response.provider_raw_validate";

pub(crate) fn control_keys() -> &'static [&'static str] {
    &[
        "control",
        "metadata_center",
        "error_chain",
        "route_facts",
        "target_selection",
        "payload_cycle",
        "stopless_state",
        "side_channel",
        "record_ledger",
        "debug",
        "diagnostics",
        "snapshot",
        "extra_fields",
    ]
}

pub(crate) fn reject_control_fields(object: &serde_json::Map<String, Value>) -> Result<(), String> {
    for key in control_keys() {
        if object.contains_key(*key) {
            return Err(format!(
                "rejects control/debug field {key} in response data"
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
    vec![
        plugin(
            PROVIDER_RAW_VALIDATE_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4ProviderRespInbound01Raw",
            "response_inbound",
            Some(1),
            PluginKind::Validator,
            PluginEffect::ReadOnly,
            PluginPhase::Admission,
            100,
            vec!["v4.response.provider_raw"],
            vec![],
        ),
        plugin(
            PROVIDER_COMPAT_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4ProviderRespCompat02ProviderCompat",
            "response_inbound",
            Some(2),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Projection,
            100,
            vec![
                "v4.response.provider_raw",
                "v4.information.provider_protocol",
            ],
            vec!["v4.response.provider_raw"],
        ),
        plugin(
            PLUGIN_ID,
            PluginCategory::Protocol,
            "V4HubRespInbound03Normalized",
            "response_inbound",
            Some(3),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            200,
            vec!["v4.response.provider_raw"],
            vec!["v4.response.normal_payload"],
        ),
    ]
}

fn provider_raw_validate(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    if !ctx.read_data().is_object() {
        return Err("provider raw response must be an object".to_string());
    }
    Ok(())
}

fn provider_compat(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let protocol = ctx
        .read_information_resource("v4.information.provider_protocol")
        .map_err(|error| error.to_string())?
        .and_then(Value::as_str)
        .ok_or_else(|| "provider response compat requires provider protocol".to_string())?
        .to_string();
    let provider_protocol = match protocol.as_str() {
        "openai-responses" => "responses",
        "openai-chat" => "chat",
        other => other,
    };
    let normalized = routecodex_v4_provider::normalize_provider_response_for_relay(
        provider_protocol,
        ctx.read_data(),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    ctx.write_data(normalized)
        .map_err(|error| error.to_string())
}

pub(crate) fn protocol_decode_entry(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let raw = data
        .as_object()
        .ok_or_else(|| "protocol_decode requires an object provider response".to_string())?;
    reject_control_fields(raw)?;

    let mut parsed = raw.clone();
    if parsed
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("response."))
    {
        return ctx
            .write_data(Value::Object(parsed))
            .map_err(|error| error.to_string());
    }
    parsed.insert("output".to_string(), normalize_output(data)?);
    ctx.write_data(Value::Object(parsed))
        .map_err(|error| error.to_string())
}

pub(crate) fn protocol_decode(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    protocol_decode_entry(ctx)
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedProviderSseFrame {
    pub semantic: Value,
    pub disposition: ProviderSseEventDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderSseEventDisposition {
    Continue,
    Completed,
    Failed { message: String },
}

/// Adjacent provider protocol codec. Transport framing is already complete;
/// this owner parses one Responses event into its semantic object.
pub fn decode_provider_sse_frame(frame: &[u8]) -> Result<DecodedProviderSseFrame, String> {
    let normalized = routecodex_v4_provider::normalize_provider_sse_frame_for_relay("responses", frame)
        .map_err(|error| {
            if error.code == "provider_sse_malformed" {
                format!("provider SSE data is invalid JSON: {}", error.message)
            } else {
                format!("provider SSE normalization failed: {}", error.message)
            }
        })?;
    let text = std::str::from_utf8(&normalized)
        .map_err(|error| format!("provider SSE frame is not UTF-8: {error}"))?;
    let mut event = None;
    let mut data = Vec::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start());
        }
    }
    let event = event.ok_or_else(|| "provider SSE frame is missing event".to_string())?;
    let raw = data.join("\n");
    let semantic: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("provider SSE data is invalid JSON: {error}"))?;
    semantic
        .as_object()
        .ok_or_else(|| "provider SSE semantic object must be an object".to_string())?;
    let semantic_type = semantic
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "provider SSE semantic object is missing type".to_string())?;
    if semantic_type != event {
        return Err(format!(
            "provider SSE event/type mismatch: {event} != {semantic_type}"
        ));
    }
    if semantic_type == "response.function_call_arguments.delta" {
        semantic
            .get("output_index")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                "provider SSE response.function_call_arguments.delta requires integer output_index"
                    .to_string()
            })?;
        semantic
            .get("delta")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "provider SSE response.function_call_arguments.delta requires string delta"
                    .to_string()
            })?;
    }
    let disposition = match semantic_type {
        "response.completed" => ProviderSseEventDisposition::Completed,
        "response.failed" => {
            let message = semantic
                .pointer("/response/error/message")
                .or_else(|| semantic.pointer("/error/message"))
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
                .ok_or_else(|| {
                    "provider SSE response.failed is missing error.message".to_string()
                })?;
            ProviderSseEventDisposition::Failed {
                message: message.to_string(),
            }
        }
        _ => ProviderSseEventDisposition::Continue,
    };
    Ok(DecodedProviderSseFrame {
        semantic,
        disposition,
    })
}

pub(crate) fn protocol_decode_handle() -> (&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)
{
    (
        PLUGIN_ID,
        protocol_decode_entry as fn(&mut ExecCtx<'_>) -> Result<(), String>,
    )
}

pub(crate) fn response_inbound_handles(
) -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![
        (
            PROVIDER_RAW_VALIDATE_PLUGIN_ID,
            provider_raw_validate as fn(&mut ExecCtx<'_>) -> Result<(), String>,
        ),
        (
            PROVIDER_COMPAT_PLUGIN_ID,
            provider_compat as fn(&mut ExecCtx<'_>) -> Result<(), String>,
        ),
        protocol_decode_handle(),
    ]
}
