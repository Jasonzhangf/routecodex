//! V4 response inbound plugin: provider raw/semantic -> parsed response.
//!
//! This module owns the `protocol_decode` descriptor and typed handle for
//! `V4HubRespInbound03Normalized`. It only consumes the adjacent
//! `v4.response.provider_raw` resource and writes the adjacent
//! `v4.response.normal_payload` resource. It never performs response
//! governance, tool harvest, continuation save/release or provider/client
//! repair, and it never writes control/error/debug/snapshot facts into data.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use super::protocol::provider_response;
use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

const PLUGIN_ID: &str = "v4.std.response.protocol_decode";
const PROVIDER_COMPAT_PLUGIN_ID: &str = "v4.std.response.provider_compat";
const PROVIDER_RAW_VALIDATE_PLUGIN_ID: &str = "v4.std.response.provider_raw_validate";
const PROVIDER_SSE_DECODE_PLUGIN_ID: &str = "v4.std.response.sse_frame_boundary";
const DIRECT_SSE_DECODE_PLUGIN_ID: &str = "v4.std.direct.response.sse_frame_boundary";

pub(crate) fn reject_control_fields(object: &serde_json::Map<String, Value>) -> Result<(), String> {
    super::boundary::reject_response_control_fields(object)
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
            DIRECT_SSE_DECODE_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4DirectResp01ProviderRaw",
            "response_inbound",
            Some(1),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            150,
            vec!["v4.direct.response.provider_raw"],
            vec![
                "v4.direct.response.provider_raw",
                "v4.control.stream_terminal",
            ],
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
            PROVIDER_SSE_DECODE_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4ProviderRespInbound01Raw",
            "response_inbound",
            Some(1),
            PluginKind::Operator,
            PluginEffect::Semantic,
            PluginPhase::Semantic,
            150,
            vec![
                "v4.response.provider_raw",
                "v4.control.provider_sse_reducer",
                "v4.information.execution_lane",
                "v4.information.client_protocol",
                "v4.information.provider_protocol",
            ],
            vec![
                "v4.response.provider_raw",
                "v4.control.stream_terminal",
                "v4.control.provider_sse_reducer",
            ],
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
    if ctx.read_transport_bytes().is_some() {
        return Ok(());
    }
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
    // Transport hands this plugin the raw provider body as the data-plane
    // value. HTTP status and content type are consumed by the typed transport
    // error owner and are never encoded into this semantic payload.
    let semantic = ctx.read_data().clone();
    let normalized =
        provider_response::normalize_provider_response_for_relay(provider_protocol, &semantic)
            .map_err(|error| error.to_string())?;
    ctx.write_data(normalized)
        .map_err(|error| error.to_string())
}

fn should_reduce_provider_sse(ctx: &mut ExecCtx<'_>) -> Result<bool, String> {
    let execution_lane = ctx
        .read_information_resource("v4.information.execution_lane")
        .map_err(|error| error.to_string())?
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let entry_protocol = ctx
        .read_information_resource("v4.information.client_protocol")
        .map_err(|error| error.to_string())?
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let provider_protocol = ctx
        .read_information_resource("v4.information.provider_protocol")
        .map_err(|error| error.to_string())?
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(execution_lane == "relay"
        && entry_protocol == "openai-chat"
        && provider_protocol == "openai-responses")
}

fn read_provider_sse_reducer(ctx: &mut ExecCtx<'_>) -> Result<ProviderSseReducer, String> {
    match ctx
        .read_control_resource("v4.control.provider_sse_reducer")
        .map_err(|error| error.to_string())?
    {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| format!("provider SSE reducer state is invalid: {error}")),
        None => Ok(ProviderSseReducer::default()),
    }
}

fn write_provider_sse_reducer(
    ctx: &mut ExecCtx<'_>,
    reducer: &ProviderSseReducer,
) -> Result<(), String> {
    let value = serde_json::to_value(reducer)
        .map_err(|error| format!("provider SSE reducer state encode failed: {error}"))?;
    ctx.write_control_resource("v4.control.provider_sse_reducer", value)
        .map_err(|error| error.to_string())
}

fn provider_sse_decode(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    provider_sse_decode_common(ctx, true)
}

fn direct_provider_sse_decode(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    provider_sse_decode_common(ctx, false)
}

fn provider_sse_decode_common(ctx: &mut ExecCtx<'_>, reduce: bool) -> Result<(), String> {
    let Some(frame) = ctx.read_transport_bytes() else {
        return Ok(());
    };
    let decoded = decode_provider_sse_frame(frame)?;
    let semantic = if reduce && should_reduce_provider_sse(ctx)? {
        let mut reducer = read_provider_sse_reducer(ctx)?;
        let semantic = reducer.reduce_event(decoded.semantic.clone())?;
        write_provider_sse_reducer(ctx, &reducer)?;
        semantic
    } else {
        decoded.semantic.clone()
    };
    let terminal = !matches!(decoded.disposition, ProviderSseEventDisposition::Continue);
    let disposition = match decoded.disposition {
        ProviderSseEventDisposition::Continue => "continue".to_string(),
        ProviderSseEventDisposition::Completed => "completed".to_string(),
        ProviderSseEventDisposition::Failed { message } => format!("failed:{message}"),
    };
    ctx.emit("provider_sse_disposition", disposition);
    ctx.write_control_resource("v4.control.stream_terminal", Value::Bool(terminal))
        .map_err(|error| error.to_string())?;
    ctx.write_data(semantic).map_err(|error| error.to_string())
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

/// Request-local Responses SSE item reducer. The codec owns event semantics;
/// the reducer only retains typed item state until a semantic terminal frame
/// materializes the complete response.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProviderSseReducer {
    output_items: BTreeMap<u64, Value>,
    response: Option<Value>,
}

impl ProviderSseReducer {
    pub fn reduce_frame(&mut self, frame: &[u8]) -> Result<Vec<u8>, String> {
        let decoded = decode_provider_sse_frame(frame)?;
        let event = self.reduce_event(decoded.semantic)?;
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "provider SSE semantic event is missing type".to_string())?;
        let encoded = serde_json::to_vec(&event)
            .map_err(|error| format!("provider SSE encode failed: {error}"))?;
        let mut reduced = format!("event: {event_type}\ndata: ").into_bytes();
        reduced.extend_from_slice(&encoded);
        reduced.extend_from_slice(b"\n\n");
        Ok(reduced)
    }

    pub fn reduce_event(&mut self, event: Value) -> Result<Value, String> {
        self.apply(&event)?;
        if matches!(
            event.get("type").and_then(Value::as_str),
            Some("response.completed" | "response.incomplete")
        ) {
            Ok(self.materialize_terminal(&event)?)
        } else {
            Ok(event)
        }
    }

    pub fn apply(&mut self, event: &Value) -> Result<(), String> {
        let object = event
            .as_object()
            .ok_or_else(|| "provider SSE semantic event must be an object".to_string())?;
        if let Some(response) = object.get("response").and_then(Value::as_object) {
            let mut retained = self
                .response
                .take()
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            for (key, value) in response {
                retained.insert(key.clone(), value.clone());
            }
            self.response = Some(Value::Object(retained));
        }
        match object.get("type").and_then(Value::as_str) {
            Some("response.output_item.added") | Some("response.output_item.done") => {
                let output_index = object
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        "provider SSE output item requires integer output_index".to_string()
                    })?;
                let mut item = object
                    .get("item")
                    .cloned()
                    .ok_or_else(|| "provider SSE output item requires item".to_string())?;
                if let Some(item) = item.as_object_mut() {
                    item.insert("output_index".to_string(), Value::from(output_index));
                }
                self.output_items.insert(output_index, item);
            }
            Some("response.function_call_arguments.delta") => {
                let output_index = object
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        "provider SSE function arguments delta requires output_index".to_string()
                    })?;
                let delta = object.get("delta").and_then(Value::as_str).ok_or_else(|| {
                    "provider SSE function arguments delta requires string delta".to_string()
                })?;
                let item = self.output_items.entry(output_index).or_insert_with(|| {
                    json!({
                        "type": "function_call",
                        "call_id": object.get("call_id").cloned().unwrap_or(Value::Null),
                        "name": Value::Null,
                        "arguments": ""
                    })
                });
                if let Some(item) = item.as_object_mut() {
                    item.insert("output_index".to_string(), Value::from(output_index));
                }
                if item.get("call_id").is_none_or(Value::is_null) {
                    if let Some(call_id) = object.get("call_id") {
                        item["call_id"] = call_id.clone();
                    }
                }
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
                    + delta;
                item["arguments"] = Value::String(arguments);
            }
            Some("response.function_call_arguments.done") => {
                let output_index = object
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        "provider SSE function arguments done requires output_index".to_string()
                    })?;
                let arguments = object.get("arguments").cloned().ok_or_else(|| {
                    "provider SSE function arguments done requires arguments".to_string()
                })?;
                let item = self.output_items.entry(output_index).or_insert_with(|| {
                    json!({
                        "type": "function_call",
                        "call_id": object.get("call_id").cloned().unwrap_or(Value::Null),
                        "name": Value::Null,
                        "arguments": ""
                    })
                });
                if let Some(item) = item.as_object_mut() {
                    item.insert("output_index".to_string(), Value::from(output_index));
                }
                item["arguments"] = arguments;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn materialize_terminal(&self, event: &Value) -> Result<Value, String> {
        let mut terminal = event
            .as_object()
            .cloned()
            .ok_or_else(|| "provider SSE terminal event must be an object".to_string())?;
        let mut response = terminal
            .get("response")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(retained) = self.response.as_ref().and_then(Value::as_object) {
            for (key, value) in retained {
                response.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        let output = response
            .entry("output".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let output = output
            .as_array_mut()
            .ok_or_else(|| "provider SSE terminal response output must be an array".to_string())?;
        for (output_index, item) in &self.output_items {
            let identity = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str);
            if let Some(identity) = identity {
                if let Some(index) = output.iter().position(|existing| {
                    existing
                        .get("call_id")
                        .or_else(|| existing.get("id"))
                        .and_then(Value::as_str)
                        == Some(identity)
                }) {
                    output[index] = item.clone();
                    continue;
                }
            }
            if let Some(index) = output.iter().enumerate().find_map(|(position, existing)| {
                let existing_index = existing
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .or_else(|| u64::try_from(position).ok());
                if existing_index != Some(*output_index) {
                    return None;
                }
                if existing
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .is_some()
                    || existing.get("type") == item.get("type")
                {
                    return Some(position);
                }
                None
            }) {
                output[index] = item.clone();
                continue;
            }
            let insert_at = usize::try_from(*output_index)
                .unwrap_or(usize::MAX)
                .min(output.len());
            output.insert(insert_at, item.clone());
        }
        terminal.insert("response".to_string(), Value::Object(response));
        Ok(Value::Object(terminal))
    }
}

/// Adjacent provider protocol codec. Transport framing is already complete;
/// this owner parses one Responses event into its semantic object.
pub fn decode_provider_sse_frame(frame: &[u8]) -> Result<DecodedProviderSseFrame, String> {
    let normalized = provider_response::normalize_provider_sse_frame_for_relay("responses", frame)
        .map_err(|error| {
            if error.starts_with("provider_sse_malformed:") {
                format!("provider SSE data is invalid JSON: {error}")
            } else {
                format!("provider SSE normalization failed: {error}")
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
    if semantic_type == "response.incomplete" {
        let reason = semantic
            .pointer("/response/incomplete_details/reason")
            .or_else(|| semantic.pointer("/incomplete_details/reason"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty());
        if !matches!(reason, Some("max_output_tokens" | "content_filter")) {
            return Err(
                "provider SSE response.incomplete requires supported incomplete_details.reason"
                    .to_string(),
            );
        }
    }
    let disposition = match semantic_type {
        "response.completed" | "response.incomplete" => ProviderSseEventDisposition::Completed,
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
        (
            PROVIDER_SSE_DECODE_PLUGIN_ID,
            provider_sse_decode as fn(&mut ExecCtx<'_>) -> Result<(), String>,
        ),
        (
            DIRECT_SSE_DECODE_PLUGIN_ID,
            direct_provider_sse_decode as fn(&mut ExecCtx<'_>) -> Result<(), String>,
        ),
        protocol_decode_handle(),
    ]
}
