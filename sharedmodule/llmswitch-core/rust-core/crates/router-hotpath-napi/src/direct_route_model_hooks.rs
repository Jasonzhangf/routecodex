use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Map, Value};

use crate::direct_semantic_classification::{
    build_direct_req_04_projection_plan, DirectFieldProjection, VrDirect03ResolvedSemantics,
};

// feature_id: hub.direct_route_model_hooks
const HISTORICAL_TOOL_IMAGE_PLACEHOLDER: &str = "historical tool image omitted";

fn trimmed(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn plan_request_hooks(input: &Value) -> Result<Value, String> {
    let root = input.as_object();
    let mut payload = root
        .and_then(|row| row.get("payload"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let resolved_value = root
        .and_then(|row| row.get("resolvedSemantics"))
        .ok_or_else(|| "direct request projector requires resolvedSemantics".to_string())?;
    let resolved: VrDirect03ResolvedSemantics = serde_json::from_value(resolved_value.clone())
        .map_err(|error| {
            format!("direct request projector received invalid resolvedSemantics: {error}")
        })?;
    let projection = build_direct_req_04_projection_plan(&resolved);
    let inbound_model = trimmed(payload.get("model")).map(str::to_string);
    let original_client_model = resolved.original_client_model.clone();
    let mut payload_changed = false;
    if let DirectFieldProjection::Set(target) = &projection.model {
        if inbound_model.as_deref() != Some(target.as_str()) {
            payload.insert("model".to_string(), Value::String(target.clone()));
            payload_changed = true;
        }
    }
    if let DirectFieldProjection::Set(level) = &projection.thinking {
        payload_changed = true;
        let mut reasoning = payload
            .get("reasoning")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        reasoning.insert("effort".to_string(), Value::String(level.clone()));
        payload.insert("reasoning_effort".to_string(), Value::String(level.clone()));
        payload.insert("reasoning".to_string(), Value::Object(reasoning));
    }
    if resolved.direct_history_tool_image_cleanup
        && replace_historical_tool_images(&mut payload) > 0
    {
        payload_changed = true;
    }
    let provider_model_id = trimmed(payload.get("model")).map(str::to_string);
    Ok(json!({
        "payload": payload,
        "originalClientModel": original_client_model,
        "providerModelId": provider_model_id,
        "payloadChanged": payload_changed,
        "resolvedSemantics": resolved,
    }))
}

fn replace_historical_tool_images(payload: &mut Map<String, Value>) -> usize {
    let mut replaced = 0;
    if let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) {
        replaced += replace_historical_responses_tool_images(input);
    }
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        replaced += replace_historical_chat_tool_images(messages);
    }
    replaced
}

fn replace_historical_responses_tool_images(input: &mut [Value]) -> usize {
    let Some(latest_user_index) = input.iter().rposition(is_responses_user_entry) else {
        return 0;
    };
    input
        .iter_mut()
        .take(latest_user_index)
        .filter_map(Value::as_object_mut)
        .filter(|entry| is_responses_tool_output_entry(entry))
        .map(|entry| replace_tool_payload_images(entry, "input_text"))
        .sum()
}

fn replace_historical_chat_tool_images(messages: &mut [Value]) -> usize {
    let Some(latest_user_index) = messages.iter().rposition(is_chat_user_message) else {
        return 0;
    };
    messages
        .iter_mut()
        .take(latest_user_index)
        .filter_map(Value::as_object_mut)
        .filter(|entry| entry.get("role").and_then(Value::as_str) == Some("tool"))
        .map(|entry| replace_tool_payload_images(entry, "text"))
        .sum()
}

fn is_responses_user_entry(entry: &Value) -> bool {
    let Some(entry) = entry.as_object() else {
        return false;
    };
    let entry_type = entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message")
        .trim()
        .to_ascii_lowercase();
    if entry_type == "input_text" || entry_type == "text" {
        return true;
    }
    entry_type == "message" && entry.get("role").and_then(Value::as_str) == Some("user")
}

fn is_chat_user_message(entry: &Value) -> bool {
    entry
        .as_object()
        .and_then(|entry| entry.get("role"))
        .and_then(Value::as_str)
        == Some("user")
}

fn is_responses_tool_output_entry(entry: &Map<String, Value>) -> bool {
    matches!(
        entry
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim(),
        "function_call_output"
            | "custom_tool_call_output"
            | "mcp_tool_call_output"
            | "tool_result"
            | "tool_message"
    )
}

fn replace_tool_payload_images(entry: &mut Map<String, Value>, text_type: &str) -> usize {
    let mut replaced = 0;
    for key in ["output", "content"] {
        if let Some(value) = entry.get_mut(key) {
            replaced += replace_image_content_items(value, text_type);
        }
    }
    replaced
}

fn replace_image_content_items(value: &mut Value, text_type: &str) -> usize {
    match value {
        Value::Array(items) => items
            .iter_mut()
            .map(|item| replace_image_content_items(item, text_type))
            .sum(),
        Value::Object(map) if is_image_content_item(map) => {
            *value = json!({
                "type": text_type,
                "text": HISTORICAL_TOOL_IMAGE_PLACEHOLDER,
            });
            1
        }
        Value::Object(map) => {
            let mut replaced = 0;
            for key in ["content", "output", "body", "items"] {
                if let Some(value) = map.get_mut(key) {
                    replaced += replace_image_content_items(value, text_type);
                }
            }
            replaced
        }
        _ => 0,
    }
}

fn is_image_content_item(map: &Map<String, Value>) -> bool {
    let item_type = map
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    item_type == "input_image"
        || item_type == "image"
        || item_type == "image_url"
        || map.contains_key("image_url")
        || (item_type.contains("image") && (map.contains_key("data") || map.contains_key("url")))
}

// feature_id: hub.router_direct_model_observation_effect_plan
fn plan_model_observation_effects(input: &Value) -> Value {
    let original_client_model = trimmed(input.get("originalClientModel"));
    let provider_model_id = trimmed(input.get("providerModelId"));
    let writes = match (original_client_model, provider_model_id) {
        (Some(client_model), Some(assigned_model)) => vec![
            json!({
                "family": "provider_observation",
                "key": "clientModelId",
                "value": client_model,
                "reason": "direct route: original client model before model override",
            }),
            json!({
                "family": "provider_observation",
                "key": "assignedModelId",
                "value": assigned_model,
                "reason": "direct route: provider-assigned model after override",
            }),
        ],
        _ => Vec::new(),
    };
    json!({
        "originalClientModel": original_client_model,
        "writes": writes,
    })
}

fn rewrite_model_fields(value: &Value, client_model: &str) -> Value {
    let Some(record) = value.as_object() else {
        return value.clone();
    };
    let mut out = record.clone();
    if trimmed(record.get("model")).is_some() {
        out.insert("model".to_string(), Value::String(client_model.to_string()));
    }
    for key in ["response", "body", "data"] {
        if record.get(key).and_then(Value::as_object).is_some() {
            out.insert(
                key.to_string(),
                rewrite_model_fields(record.get(key).expect("checked object"), client_model),
            );
        }
    }
    Value::Object(out)
}

fn rewrite_sse_frame(frame: &str, client_model: &str) -> String {
    frame
        .split('\n')
        .map(|line| {
            let clean = line.strip_suffix('\r').unwrap_or(line);
            let Some(raw) = clean.strip_prefix("data:") else {
                return line.to_string();
            };
            let raw = raw.strip_prefix(' ').unwrap_or(raw);
            if raw.is_empty() || raw == "[DONE]" {
                return line.to_string();
            }
            let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
                return line.to_string();
            };
            let rewritten = rewrite_model_fields(&parsed, client_model);
            format!(
                "data: {}",
                serde_json::to_string(&rewritten).expect("JSON value serializes")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn project_headers(input: &Value) -> Value {
    let mut headers = Map::new();
    if let Some(source) = input.as_object() {
        for (key, value) in source {
            if let Some(text) = trimmed(Some(value)) {
                headers.insert(key.clone(), Value::String(text.to_string()));
            }
        }
    }
    let has_content_type = headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("content-type"));
    let has_cache_control = headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("cache-control"));
    let has_connection = headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("connection"));
    if !has_content_type {
        headers.insert(
            "Content-Type".to_string(),
            Value::String("text/event-stream; charset=utf-8".to_string()),
        );
    }
    if !has_cache_control {
        headers.insert(
            "Cache-Control".to_string(),
            Value::String("no-cache, no-transform".to_string()),
        );
    }
    if !has_connection {
        headers.insert(
            "Connection".to_string(),
            Value::String("keep-alive".to_string()),
        );
    }
    Value::Object(headers)
}

fn run(input_json: String, builder: fn(&Value) -> Value) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct route model hook input parse failed: {error}"
        ))
    })?;
    serde_json::to_string(&builder(&input)).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct route model hook output serialize failed: {error}"
        ))
    })
}

fn run_result(
    input_json: String,
    builder: fn(&Value) -> Result<Value, String>,
) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("direct semantic input parse failed: {error}"))
    })?;
    let output = builder(&input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!("direct semantic output serialize failed: {error}"))
    })
}

#[napi(js_name = "planDirectRouteRequestHooksJson")]
pub fn plan_direct_route_request_hooks_json(input_json: String) -> NapiResult<String> {
    run_result(input_json, plan_request_hooks)
}

#[napi(js_name = "planDirectRouteModelObservationEffectsJson")]
pub fn plan_direct_route_model_observation_effects_json(input_json: String) -> NapiResult<String> {
    run(input_json, plan_model_observation_effects)
}

#[napi(js_name = "rewriteDirectRouteResponseModelJson")]
pub fn rewrite_direct_route_response_model_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("direct response model input parse failed: {error}"))
    })?;
    let model = trimmed(input.get("clientModel")).unwrap_or_default();
    serde_json::to_string(&rewrite_model_fields(
        input.get("value").unwrap_or(&Value::Null),
        model,
    ))
    .map_err(|error| {
        napi::Error::from_reason(format!(
            "direct response model output serialize failed: {error}"
        ))
    })
}

#[napi(js_name = "rewriteDirectRouteSseFrameJson")]
pub fn rewrite_direct_route_sse_frame_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("direct SSE model input parse failed: {error}"))
    })?;
    let frame = input
        .get("frame")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let model = trimmed(input.get("clientModel")).unwrap_or_default();
    serde_json::to_string(&rewrite_sse_frame(frame, model)).map_err(|error| {
        napi::Error::from_reason(format!("direct SSE model output serialize failed: {error}"))
    })
}

#[napi(js_name = "projectDirectRouteSseHeadersJson")]
pub fn project_direct_route_sse_headers_json(input_json: String) -> NapiResult<String> {
    run(input_json, project_headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::direct_semantic_classification::resolve_direct_semantic_classification;

    #[test]
    fn request_plan_keeps_canonical_wire_model_and_thinking_truth() {
        let resolved = resolve_direct_semantic_classification(&json!({
            "payload": {"model":"deepseek-v4-pro", "reasoning":{"summary":"auto"}},
            "targetModelId":"DeepSeek-V4-Pro",
            "routeThinking":"max"
        }))
        .expect("resolved routing semantics");
        let output = plan_request_hooks(&json!({
            "payload": {"model":"deepseek-v4-pro", "reasoning":{"summary":"auto"}},
            "resolvedSemantics": resolved
        }))
        .expect("routing request plan");
        assert_eq!(output["payload"]["model"], "DeepSeek-V4-Pro");
        assert_eq!(output["originalClientModel"], "deepseek-v4-pro");
        assert_eq!(output["payload"]["reasoning_effort"], "xhigh");
        assert_eq!(output["payload"]["reasoning"]["summary"], "auto");
    }

    #[test]
    fn resolved_passthrough_semantics_preserve_request_model_and_thinking() {
        let resolved = resolve_direct_semantic_classification(&json!({
            "directSemantic": "passthrough",
            "selectedProviderKey": "provider.key1.wire-model",
            "selectedRuntimeKey": "provider.key1",
            "targetModelId": "wire-model",
            "payload": {
                "model": "client-model",
                "reasoning_effort": "low",
                "reasoning": { "effort": "low", "summary": "auto" }
            },
            "routeThinking": "high"
        }))
        .expect("resolved passthrough semantics");
        assert_eq!(
            resolved.semantic_class,
            crate::direct_semantic_classification::DirectSemanticClass::Passthrough
        );
        let output = plan_request_hooks(&json!({
            "payload": {
                "model": "client-model",
                "reasoning_effort": "low",
                "reasoning": { "effort": "low", "summary": "auto" }
            },
            "resolvedSemantics": resolved
        }))
        .expect("passthrough request plan");
        assert_eq!(output["payload"]["model"], "client-model");
        assert_eq!(output["payload"]["reasoning_effort"], "low");
        assert_eq!(output["payload"]["reasoning"]["effort"], "low");
        assert_eq!(output["payloadChanged"], false);
    }

    #[test]
    fn request_plan_replaces_historical_tool_images_when_configured() {
        let resolved = resolve_direct_semantic_classification(&json!({
            "directSemantic": "routing",
            "targetModelId": "gpt-5.6-sol",
            "directHistoryToolImageCleanup": true,
            "payload": { "model": "gpt-5.6" }
        }))
        .expect("resolved routing semantics");

        let output = plan_request_hooks(&json!({
            "payload": {
                "model": "gpt-5.6",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "old" }] },
                    { "type": "function_call_output", "call_id": "old_call", "output": [
                        { "type": "input_image", "image_url": "data:image/png;base64,OLD" },
                        { "type": "input_text", "text": "keep text" }
                    ] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "new" }] },
                    { "type": "function_call_output", "call_id": "new_call", "output": [
                        { "type": "input_image", "image_url": "data:image/png;base64,NEW" }
                    ] }
                ]
            },
            "resolvedSemantics": resolved
        }))
        .expect("routing request plan");

        assert_eq!(output["payloadChanged"], true);
        assert_eq!(
            output["payload"]["input"][1]["output"][0],
            json!({ "type": "input_text", "text": "historical tool image omitted" })
        );
        assert_eq!(
            output["payload"]["input"][3]["output"][0]["image_url"],
            json!("data:image/png;base64,NEW")
        );
    }

    #[test]
    fn request_plan_preserves_historical_tool_images_without_config() {
        let resolved = resolve_direct_semantic_classification(&json!({
            "directSemantic": "routing",
            "targetModelId": "gpt-5.6-sol",
            "payload": { "model": "gpt-5.6" }
        }))
        .expect("resolved routing semantics");

        let output = plan_request_hooks(&json!({
            "payload": {
                "model": "gpt-5.6",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "old" }] },
                    { "type": "function_call_output", "call_id": "old_call", "output": [
                        { "type": "input_image", "image_url": "data:image/png;base64,OLD" }
                    ] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "new" }] }
                ]
            },
            "resolvedSemantics": resolved
        }))
        .expect("routing request plan");

        assert_eq!(
            output["payload"]["input"][1]["output"][0]["image_url"],
            json!("data:image/png;base64,OLD")
        );
    }

    #[test]
    fn resolved_semantics_reject_unknown_class_and_missing_request_contract() {
        assert!(resolve_direct_semantic_classification(&json!({
            "directSemantic": "invalid",
            "payload": {"model": "client"},
            "targetModelId": "wire"
        }))
        .is_err());
        assert!(plan_request_hooks(&json!({
            "payload": {"model": "client"}
        }))
        .is_err());
    }

    #[test]
    fn model_observation_effects_require_a_real_override_pair() {
        let output = plan_model_observation_effects(&json!({
            "originalClientModel":" client-alias ",
            "providerModelId":" Wire-Model "
        }));
        assert_eq!(output["originalClientModel"], "client-alias");
        assert_eq!(output["writes"][0]["key"], "clientModelId");
        assert_eq!(output["writes"][0]["value"], "client-alias");
        assert_eq!(output["writes"][1]["key"], "assignedModelId");
        assert_eq!(output["writes"][1]["value"], "Wire-Model");
        assert_eq!(
            plan_model_observation_effects(&json!({"providerModelId":"Wire"}))["writes"],
            json!([])
        );
        assert_eq!(
            plan_model_observation_effects(&json!({"originalClientModel":"client"}))["writes"],
            json!([])
        );
    }

    #[test]
    fn response_rewrite_restores_wrapped_data_model_without_touching_nested_payload() {
        let output = rewrite_model_fields(
            &json!({
                "status":200,
                "data":{"model":"DeepSeek-V4-Pro", "result":{"model":"internal"}}
            }),
            "deepseek-v4-pro",
        );
        assert_eq!(output["data"]["model"], "deepseek-v4-pro");
        assert_eq!(output["data"]["result"]["model"], "internal");
    }

    #[test]
    fn malformed_sse_data_is_preserved_while_standard_model_is_rewritten() {
        assert_eq!(
            rewrite_sse_frame("event: x\ndata: nope", "client"),
            "event: x\ndata: nope"
        );
        assert_eq!(
            rewrite_sse_frame("  \ndata: [DONE]\n", "client"),
            "  \ndata: [DONE]\n"
        );
        let output = rewrite_sse_frame(
            "event: response.created\ndata: {\"response\":{\"model\":\"wire\"}}",
            "client",
        );
        assert!(output.contains("\"model\":\"client\""));
    }
}
