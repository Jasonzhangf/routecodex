use napi::bindgen_prelude::Result as NapiResult;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use uuid::Uuid;

use crate::hub_reasoning_tool_normalizer::normalize_function_call_id_json;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizeIdValueInput {
    value: Option<Value>,
    force_generate: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractToolCallIdInput {
    obj: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateToolCallIdTransformerInput {
    style: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransformToolCallIdInput {
    state: Option<Value>,
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnforceToolCallIdStyleInput {
    messages: Option<Vec<Value>>,
    state: Option<Value>,
}

fn read_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

fn tool_call_id_style(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or("").trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

fn is_fc_style(style: &str) -> bool {
    style == "fc"
}

fn is_preserve_style(style: &str) -> bool {
    style == "preserve"
}

fn generate_uuid() -> String {
    Uuid::new_v4().to_string()
}

fn normalize_id_with_style(style: &str, raw: Option<&str>, fallback: &str) -> String {
    if is_fc_style(style) {
        let input = serde_json::json!({
            "callId": raw,
            "fallback": fallback
        });
        if let Ok(raw_json) = serde_json::to_string(&input) {
            if let Ok(result) = normalize_function_call_id_json(raw_json) {
                if let Ok(parsed) = serde_json::from_str::<Value>(&result) {
                    if let Some(value) = parsed.as_str() {
                        let trimmed = value.trim();
                        if !trimmed.is_empty() {
                            return trimmed.to_string();
                        }
                    }
                }
            }
        }
        return fallback.to_string();
    }
    if let Some(raw) = raw {
        if !raw.trim().is_empty() {
            return raw.trim().to_string();
        }
    }
    generate_uuid()
}

fn extract_tool_call_id(obj: &Map<String, Value>) -> Option<String> {
    read_string(obj.get("tool_call_id"))
        .or_else(|| read_string(obj.get("call_id")))
        .or_else(|| read_string(obj.get("id")))
        .or_else(|| read_string(obj.get("tool_use_id")))
}

#[napi_derive::napi]
pub fn normalize_id_value_json(input_json: String) -> NapiResult<String> {
    let input: NormalizeIdValueInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let force = input.force_generate.unwrap_or(false);
    if force {
        return serde_json::to_string(&Value::String(generate_uuid()))
            .map_err(|e| napi::Error::from_reason(e.to_string()));
    }
    if let Some(Value::String(raw)) = input.value {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return serde_json::to_string(&Value::String(trimmed.to_string()))
                .map_err(|e| napi::Error::from_reason(e.to_string()));
        }
    }
    serde_json::to_string(&Value::String(generate_uuid()))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn extract_tool_call_id_json(input_json: String) -> NapiResult<String> {
    let input: ExtractToolCallIdInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let obj = input.obj.unwrap_or(Value::Null);
    let id = obj
        .as_object()
        .and_then(extract_tool_call_id)
        .map(Value::String)
        .unwrap_or(Value::Null);
    serde_json::to_string(&id).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn create_tool_call_id_transformer_json(input_json: String) -> NapiResult<String> {
    let input: CreateToolCallIdTransformerInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let style_raw = input.style.unwrap_or_default();
    let style = tool_call_id_style(Some(style_raw.as_str())).unwrap_or_else(|| "fc".to_string());
    let state = serde_json::json!({
        "style": style,
        "counter": 0u64,
        "aliasMap": {}
    });
    serde_json::to_string(&state).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn transform_tool_call_id_json(input_json: String) -> NapiResult<String> {
    let input: TransformToolCallIdInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut state = input.state.unwrap_or(Value::Null);
    let Some(state_obj) = state.as_object_mut() else {
        return Err(napi::Error::from_reason("invalid transformer state"));
    };
    let style = state_obj
        .get("style")
        .and_then(Value::as_str)
        .unwrap_or("fc")
        .to_ascii_lowercase();
    let mut counter = state_obj
        .get("counter")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut alias_map: HashMap<String, String> = match state_obj.get("aliasMap") {
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        _ => HashMap::new(),
    };

    let raw_id = input.id.unwrap_or_default();
    let trimmed = raw_id.trim().to_string();
    let normalized = if is_fc_style(style.as_str()) {
        if trimmed.is_empty() {
            counter += 1;
        }
        let fallback = if trimmed.is_empty() {
            format!("fc_{}", counter)
        } else {
            format!("fc_{}", counter.max(1))
        };
        normalize_id_with_style(
            style.as_str(),
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.as_str())
            },
            fallback.as_str(),
        )
    } else if is_preserve_style(style.as_str()) {
        if let Some(existing) = alias_map.get(trimmed.as_str()) {
            existing.clone()
        } else {
            let value = if trimmed.is_empty() {
                generate_uuid()
            } else {
                trimmed.clone()
            };
            if !trimmed.is_empty() {
                alias_map.insert(trimmed.clone(), value.clone());
            }
            value
        }
    } else {
        if trimmed.is_empty() {
            generate_uuid()
        } else {
            trimmed.clone()
        }
    };

    state_obj.insert("style".to_string(), Value::String(style));
    state_obj.insert("counter".to_string(), Value::Number(counter.into()));
    let alias_value = Value::Object(
        alias_map
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect(),
    );
    state_obj.insert("aliasMap".to_string(), alias_value);

    let output = serde_json::json!({
        "id": normalized,
        "state": state
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn enforce_tool_call_id_style_json(input_json: String) -> NapiResult<String> {
    let input: EnforceToolCallIdStyleInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut messages = input.messages.unwrap_or_default();
    let mut state = input.state.unwrap_or(Value::Null);

    for message in messages.iter_mut() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        if role == "assistant" {
            if let Some(Value::Array(tool_calls)) = message_obj.get_mut("tool_calls") {
                for call in tool_calls.iter_mut() {
                    let Some(call_obj) = call.as_object_mut() else {
                        continue;
                    };
                    let id = extract_tool_call_id(call_obj);
                    if id.is_none() {
                        continue;
                    }
                    let input_payload = serde_json::json!({
                        "state": state,
                        "id": id.clone()
                    });
                    let raw = transform_tool_call_id_json(input_payload.to_string())?;
                    let parsed: Value = serde_json::from_str(&raw)
                        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
                    let next_id = parsed.get("id").and_then(Value::as_str).unwrap_or("");
                    state = parsed.get("state").cloned().unwrap_or(Value::Null);
                    if !next_id.is_empty() {
                        call_obj.insert("id".to_string(), Value::String(next_id.to_string()));
                    }
                }
            }
        }

        if role == "tool" {
            let id = extract_tool_call_id(message_obj);
            if id.is_none() {
                continue;
            }
            let input_payload = serde_json::json!({
                "state": state,
                "id": id.clone()
            });
            let raw = transform_tool_call_id_json(input_payload.to_string())?;
            let parsed: Value =
                serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))?;
            let next_id = parsed.get("id").and_then(Value::as_str).unwrap_or("");
            state = parsed.get("state").cloned().unwrap_or(Value::Null);
            if !next_id.is_empty() {
                message_obj.insert(
                    "tool_call_id".to_string(),
                    Value::String(next_id.to_string()),
                );
            }
        }
    }

    let output = serde_json::json!({
        "messages": messages,
        "state": state
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests;
