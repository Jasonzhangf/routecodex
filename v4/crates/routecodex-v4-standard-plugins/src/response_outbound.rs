//! V4 response outbound plugins: governed response -> client semantic -> frame.
//!
//! This module owns the Relay response projection helper and the final client
//! frame builder. Registered Direct/Relay hooks invoke the helper; SSE framing
//! stays in the independent opaque transport plugin.

use routecodex_v4_cordis_bridge::ExecCtx;
use serde_json::{json, Map, Value};

use super::response_inbound::reject_control_fields;
use super::{plugin, PluginCategory, PluginEffect, PluginKind, PluginPhase, StandardPlugin};

const FRAME_BUILD_ID: &str = "v4.std.response.frame_build";

pub(crate) fn response_outbound_descriptors() -> Vec<StandardPlugin> {
    vec![plugin(
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
    )]
}

fn responses_text(value: &Value) -> String {
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn responses_tool_calls(value: &Value) -> Vec<Value> {
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .map(|item| {
            json!({
                "id": item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or(Value::Null),
                "type": "function",
                "function": {
                    "name": item.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": item.get("arguments").cloned().unwrap_or_else(|| Value::String(String::new()))
                }
            })
        })
        .collect()
}

fn project_usage(value: &Value) -> Value {
    let Some(usage) = value.get("usage").and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut projected = Map::new();
    for (source, target) in [
        ("input_tokens", "prompt_tokens"),
        ("output_tokens", "completion_tokens"),
        ("total_tokens", "total_tokens"),
        ("input_tokens_details", "prompt_tokens_details"),
        ("output_tokens_details", "completion_tokens_details"),
    ] {
        if let Some(field) = usage.get(source) {
            projected.insert(target.to_string(), field.clone());
        }
    }
    Value::Object(projected)
}

pub(crate) fn project_responses_to_chat(value: &Value) -> Value {
    if value.get("type").is_some() {
        return project_responses_event_to_chat(value);
    }
    let tool_calls = responses_tool_calls(value);
    let text = responses_text(value);
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() { Value::Null } else { Value::String(text) }
    });
    if !tool_calls.is_empty() {
        message
            .as_object_mut()
            .expect("chat message is an object")
            .insert("tool_calls".to_string(), Value::Array(tool_calls.clone()));
    }
    json!({
        "id": value.get("id").cloned().unwrap_or_else(|| Value::String(String::new())),
        "object": "chat.completion",
        "created": value.get("created_at").cloned().unwrap_or_else(|| Value::Number(0.into())),
        "model": value.get("model").cloned().unwrap_or_else(|| Value::String(String::new())),
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" }
        }],
        "usage": project_usage(value)
    })
}

fn project_responses_event_to_chat(value: &Value) -> Value {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let response = value.get("response").unwrap_or(value);
    let mut delta = Map::new();
    let mut finish_reason = Value::Null;
    match event_type {
        "response.created" | "response.in_progress" => {
            delta.insert("role".to_string(), Value::String("assistant".to_string()));
            delta.insert("content".to_string(), Value::String(String::new()));
        }
        "response.output_text.delta" => {
            delta.insert(
                "content".to_string(),
                value.get("delta").cloned().unwrap_or_else(|| Value::String(String::new())),
            );
        }
        "response.completed" => {
            finish_reason = Value::String(
                if responses_tool_calls(response).is_empty() { "stop" } else { "tool_calls" }
                    .to_string(),
            );
        }
        _ => {}
    }
    json!({
        "id": response.get("id").cloned().unwrap_or_else(|| Value::String(String::new())),
        "object": "chat.completion.chunk",
        "created": response.get("created_at").cloned().unwrap_or_else(|| Value::Number(0.into())),
        "model": response.get("model").cloned().unwrap_or_else(|| Value::String(String::new())),
        "choices": [{"index": 0, "delta": Value::Object(delta), "finish_reason": finish_reason}]
    })
}

fn frame_build(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    let semantic = data
        .as_object()
        .ok_or_else(|| "frame_build requires an object client semantic".to_string())?;

    reject_control_fields(semantic)?;
    ctx.write_data(Value::Object(semantic.clone()))
        .map_err(|error| error.to_string())
}

pub(crate) fn frame_build_handle() -> (&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>) {
    (
        FRAME_BUILD_ID,
        frame_build as fn(&mut ExecCtx<'_>) -> Result<(), String>,
    )
}

pub(crate) fn response_outbound_handles(
) -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![frame_build_handle()]
}
