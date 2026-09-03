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
pub const REQUEST_PROTOCOL_PARSE_PLUGIN_ID: &str = "v4.std.request.protocol_parse";

pub(crate) fn reject_control(object: &Map<String, Value>) -> Result<(), String> {
    super::boundary::reject_control_fields(object)
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
    let messages = messages
        .into_iter()
        .map(|message| {
            let mut message = message
                .as_object()
                .cloned()
                .ok_or_else(|| "Chat message must be an object".to_string())?;
            if let Some(content) = message.get("content").cloned() {
                let content = match content {
                    Value::String(text) => Value::Array(vec![json!({
                        "type": "input_text",
                        "text": text,
                    })]),
                    Value::Array(items) => Value::Array(
                        items
                            .into_iter()
                            .map(|item| {
                                let mut item = item.as_object().cloned().unwrap_or_default();
                                if item.get("type").and_then(Value::as_str) == Some("text") {
                                    item.insert("type".to_string(), json!("input_text"));
                                }
                                Value::Object(item)
                            })
                            .collect(),
                    ),
                    other => other,
                };
                message.insert("content".to_string(), content);
            }
            Ok(Value::Object(message))
        })
        .collect::<Result<Vec<_>, String>>()?;
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

pub(crate) fn request_protocol_parse(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let object = require_object(ctx, "request_protocol_parse")?;
    reject_control(&object)?;
    if object
        .get("model")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err("request_protocol_parse requires model".to_string());
    }
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
    let mut object = require_object(ctx, "wire_build")?;
    reject_control(&object)?;
    object
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "wire_build requires model".to_string())?;
    let client_protocol = ctx
        .read_information_resource("v4.information.client_protocol")
        .map_err(|error| error.to_string())?
        .and_then(Value::as_str)
        .ok_or_else(|| "wire_build requires client protocol information".to_string())?
        .to_string();
    let provider_protocol = ctx
        .read_information_resource("v4.information.provider_protocol")
        .map_err(|error| error.to_string())?
        .and_then(Value::as_str)
        .ok_or_else(|| "wire_build requires provider protocol information".to_string())?
        .to_string();
    let client_protocol = match client_protocol.as_str() {
        "openai-chat" | "chat" => "chat",
        "openai-responses" | "responses" => "responses",
        other => return Err(format!("unsupported client protocol {other}")),
    };
    let provider_protocol = match provider_protocol.as_str() {
        "openai-chat" | "chat" => "chat",
        "openai-responses" | "responses" => "responses",
        other => return Err(format!("unsupported provider protocol {other}")),
    };
    match (client_protocol, provider_protocol) {
        ("chat", "responses") => {
            if object.contains_key("messages") {
                object = project_chat_request_to_responses(&Value::Object(object))?
                    .as_object()
                    .cloned()
                    .ok_or_else(|| "chat-to-Responses projection must return object".to_string())?;
            } else if !object.contains_key("input") {
                return Err("Chat-to-Responses wire requires messages or input".to_string());
            }
        }
        ("chat", "chat") if !object.contains_key("messages") => {
            return Err("chat wire requires messages".to_string());
        }
        ("responses", "responses") if !object.contains_key("input") => {
            return Err("Responses wire requires input".to_string());
        }
        ("responses", "chat") => {
            return Err("Responses-to-Chat wire projection is not registered".to_string());
        }
        _ => {}
    }
    // Preserve the complete protocol business envelope. Responses fields such
    // as previous_response_id and store are client/provider payload semantics,
    // not runtime control state, and must not be silently discarded.
    ctx.write_data(Value::Object(object))
        .map_err(|error| error.to_string())
}

pub(crate) fn descriptors() -> Vec<StandardPlugin> {
    vec![
        plugin(
            REQUEST_PROTOCOL_PARSE_PLUGIN_ID,
            PluginCategory::Protocol,
            "V4ServerReqInbound01ClientRaw",
            "request_inbound",
            Some(1),
            PluginKind::Operator,
            PluginEffect::ReadOnly,
            PluginPhase::Semantic,
            100,
            vec!["v4.request.normal_payload"],
            vec![],
        ),
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
            "v4.std.chat_process.request_governance",
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
            vec![
                "v4.request.provider_semantic",
                "v4.information.client_protocol",
                "v4.information.provider_protocol",
            ],
            vec!["v4.request.provider_wire_payload"],
        ),
    ]
}

pub(crate) fn handles() -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![
        (REQUEST_PROTOCOL_PARSE_PLUGIN_ID, request_protocol_parse),
        (REQUEST_NORMALIZE_PLUGIN_ID, request_normalize),
        ("v4.std.chat_process.request_governance", request_governance),
        ("v4.std.request.responses_wire_build", wire_build),
    ]
}
