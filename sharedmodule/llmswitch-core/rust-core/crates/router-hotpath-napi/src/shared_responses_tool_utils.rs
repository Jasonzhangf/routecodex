use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::hub_bridge_actions::utils::{
    normalize_function_call_id, normalize_function_call_output_id,
};

const RAW_SYSTEM_SENTINEL: &str = "__rcc_raw_system";
const MAX_RESPONSES_ITEM_ID_LENGTH: usize = 64;

fn sanitize_core(value: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in value.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if normalized == '_' {
            if !prev_underscore {
                out.push('_');
            }
            prev_underscore = true;
        } else {
            out.push(normalized);
            prev_underscore = false;
        }
    }
    out.trim_matches('_').to_string()
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest.iter().take(5) {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn clamp_prefixed_id(prefix: &str, core: &str, hash_source: &str) -> String {
    let sanitized = {
        let raw = sanitize_core(core);
        if raw.is_empty() {
            Uuid::new_v4().simple().to_string()[..8].to_string()
        } else {
            raw
        }
    };
    let direct = format!("{}{}", prefix, sanitized);
    if direct.len() <= MAX_RESPONSES_ITEM_ID_LENGTH {
        return direct;
    }
    let hash = short_hash(&format!("{}|{}|{}", prefix, hash_source, sanitized));
    let room = std::cmp::max(
        1,
        MAX_RESPONSES_ITEM_ID_LENGTH.saturating_sub(prefix.len() + 1 + hash.len()),
    );
    let head = {
        let raw = sanitize_core(&sanitized.chars().take(room).collect::<String>());
        if raw.is_empty() {
            "id".to_string()
        } else {
            raw
        }
    };
    format!("{}{}_{}", prefix, head, hash)
}

fn extract_core(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut sanitized = sanitize_core(trimmed);
    if sanitized.is_empty() {
        return None;
    }
    let lower = sanitized.to_ascii_lowercase();
    if lower.starts_with("fc_") || lower.starts_with("fc-") {
        sanitized = sanitized[3..].to_string();
    } else if lower.starts_with("call_") || lower.starts_with("call-") {
        sanitized = sanitized[5..].to_string();
    }
    let normalized = sanitize_core(&sanitized);
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn normalize_responses_call_id(call_id: Option<&str>, fallback: &str) -> String {
    if let Some(call_core) = extract_core(call_id) {
        return clamp_prefixed_id("call_", &call_core, call_id.unwrap_or_default());
    }
    if let Some(fallback_core) = extract_core(Some(fallback)) {
        return clamp_prefixed_id("call_", &fallback_core, fallback);
    }
    let random_core = Uuid::new_v4().simple().to_string()[..8].to_string();
    clamp_prefixed_id("call_", &random_core, &random_core)
}

fn is_stable_tool_call_id(raw: &str) -> bool {
    let trimmed = raw.trim();
    !trimmed.is_empty() && {
        let lower = trimmed.to_ascii_lowercase();
        lower.starts_with("fc_") || lower.starts_with("call_")
    }
}

fn normalize_responses_tool_call_ids_impl(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };

    let mut counter: i64 = 0;
    let mut alias_map: Map<String, Value> = Map::new();
    let next_fallback = |prefix: &str, counter: &mut i64| -> String {
        *counter += 1;
        format!("{}_{}", prefix, counter)
    };

    let normalize_call_id = |raw: Option<&str>,
                             fallback_prefix: &str,
                             counter: &mut i64,
                             alias_map: &mut Map<String, Value>|
     -> String {
        let trimmed = raw.unwrap_or("").trim().to_string();
        if !trimmed.is_empty() {
            if let Some(cached) = alias_map.get(trimmed.as_str()).and_then(Value::as_str) {
                return cached.to_string();
            }
        }
        let normalized = if is_stable_tool_call_id(trimmed.as_str()) {
            trimmed.clone()
        } else {
            normalize_function_call_id(
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.as_str())
                },
                next_fallback(fallback_prefix, counter).as_str(),
            )
        };
        if !trimmed.is_empty() {
            alias_map.insert(trimmed, Value::String(normalized.clone()));
        }
        normalized
    };

    if let Some(output) = root.get_mut("output").and_then(Value::as_array_mut) {
        for item in output.iter_mut() {
            let Some(item_obj) = item.as_object_mut() else {
                continue;
            };
            let item_type = item_obj
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            if item_type == "function_call" {
                let normalized_call_id = normalize_call_id(
                    item_obj
                        .get("call_id")
                        .and_then(Value::as_str)
                        .or_else(|| item_obj.get("tool_call_id").and_then(Value::as_str))
                        .or_else(|| item_obj.get("id").and_then(Value::as_str)),
                    "fc_call",
                    &mut counter,
                    &mut alias_map,
                );
                item_obj.insert(
                    "call_id".to_string(),
                    Value::String(normalized_call_id.clone()),
                );
                if item_obj.contains_key("tool_call_id") {
                    item_obj.insert(
                        "tool_call_id".to_string(),
                        Value::String(normalized_call_id.clone()),
                    );
                }
                let raw_output_id = item_obj.get("id").and_then(Value::as_str);
                let fallback_output_id = raw_output_id
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| next_fallback("fc", &mut counter));
                let normalized_output_id = normalize_function_call_output_id(
                    Some(normalized_call_id.as_str()),
                    fallback_output_id.as_str(),
                );
                item_obj.insert("id".to_string(), Value::String(normalized_output_id));
                continue;
            }

            if item_type == "function_call_output"
                || item_type == "tool_result"
                || item_type == "tool_message"
            {
                let normalized_call_id = normalize_call_id(
                    item_obj
                        .get("call_id")
                        .and_then(Value::as_str)
                        .or_else(|| item_obj.get("tool_call_id").and_then(Value::as_str))
                        .or_else(|| item_obj.get("id").and_then(Value::as_str)),
                    "fc_call",
                    &mut counter,
                    &mut alias_map,
                );
                item_obj.insert(
                    "call_id".to_string(),
                    Value::String(normalized_call_id.clone()),
                );
                if item_obj.contains_key("tool_call_id") {
                    item_obj.insert(
                        "tool_call_id".to_string(),
                        Value::String(normalized_call_id.clone()),
                    );
                }
                let raw_output_id = item_obj.get("id").and_then(Value::as_str);
                let fallback_output_id = raw_output_id
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| next_fallback("fc", &mut counter));
                let normalized_output_id = normalize_function_call_output_id(
                    Some(normalized_call_id.as_str()),
                    fallback_output_id.as_str(),
                );
                item_obj.insert("id".to_string(), Value::String(normalized_output_id));
                continue;
            }

            if let Some(tool_calls) = item_obj.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for call in tool_calls.iter_mut() {
                    let Some(call_obj) = call.as_object_mut() else {
                        continue;
                    };
                    let normalized_call_id = normalize_call_id(
                        call_obj
                            .get("id")
                            .and_then(Value::as_str)
                            .or_else(|| call_obj.get("tool_call_id").and_then(Value::as_str))
                            .or_else(|| call_obj.get("call_id").and_then(Value::as_str)),
                        "fc_call",
                        &mut counter,
                        &mut alias_map,
                    );
                    call_obj.insert("id".to_string(), Value::String(normalized_call_id.clone()));
                    if call_obj.contains_key("tool_call_id") {
                        call_obj.insert(
                            "tool_call_id".to_string(),
                            Value::String(normalized_call_id.clone()),
                        );
                    }
                    if call_obj.contains_key("call_id") {
                        call_obj.insert("call_id".to_string(), Value::String(normalized_call_id));
                    }
                }
            }
        }
    }

    if let Some(tool_calls) = root
        .get_mut("required_action")
        .and_then(Value::as_object_mut)
        .and_then(|v| v.get_mut("submit_tool_outputs"))
        .and_then(Value::as_object_mut)
        .and_then(|v| v.get_mut("tool_calls"))
        .and_then(Value::as_array_mut)
    {
        for call in tool_calls.iter_mut() {
            let Some(call_obj) = call.as_object_mut() else {
                continue;
            };
            let normalized_call_id = normalize_call_id(
                call_obj
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .or_else(|| call_obj.get("id").and_then(Value::as_str))
                    .or_else(|| call_obj.get("call_id").and_then(Value::as_str)),
                "fc_call",
                &mut counter,
                &mut alias_map,
            );
            call_obj.insert(
                "tool_call_id".to_string(),
                Value::String(normalized_call_id.clone()),
            );
            call_obj.insert("id".to_string(), Value::String(normalized_call_id.clone()));
            if call_obj.contains_key("call_id") {
                call_obj.insert("call_id".to_string(), Value::String(normalized_call_id));
            }
        }
    }
}

fn resolve_tool_call_id_style_impl(metadata: &Value) -> String {
    let raw = metadata
        .as_object()
        .and_then(|v| v.get("toolCallIdStyle"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match raw.as_str() {
        "preserve" => "preserve".to_string(),
        _ => "fc".to_string(),
    }
}

fn prune_private_extra_fields(target: &mut Map<String, Value>) {
    let keys: Vec<String> = target.keys().cloned().collect();
    for key in keys {
        if key.starts_with("__rcc_") {
            target.remove(key.as_str());
            continue;
        }
        let remove_empty = if let Some(Value::Object(child)) = target.get_mut(key.as_str()) {
            prune_private_extra_fields(child);
            child.is_empty()
        } else {
            false
        };
        if remove_empty {
            target.remove(key.as_str());
        }
    }
}

pub(crate) fn strip_internal_tooling_metadata_impl(metadata: &mut Value) {
    let Some(record) = metadata.as_object_mut() else {
        return;
    };
    record.remove("toolCallIdStyle");
    record.remove(RAW_SYSTEM_SENTINEL);
    let remove_extra = if let Some(Value::Object(extra_fields)) = record.get_mut("extraFields") {
        prune_private_extra_fields(extra_fields);
        extra_fields.is_empty()
    } else {
        false
    };
    if remove_extra {
        record.remove("extraFields");
    }
}

#[napi]
pub fn normalize_responses_tool_call_ids_json(payload_json: String) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    normalize_responses_tool_call_ids_impl(&mut payload);
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_tool_call_id_style_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&Value::String(resolve_tool_call_id_style_impl(&metadata)))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn strip_internal_tooling_metadata_json(metadata_json: String) -> NapiResult<String> {
    let mut metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    strip_internal_tooling_metadata_impl(&mut metadata);
    serde_json::to_string(&metadata).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_responses_tool_call_ids_payload() {
        let mut payload = serde_json::json!({
            "output": [
                { "type": "function_call", "id": "toolu_1", "call_id": "toolu_1" },
                { "type": "function_call_output", "id": "result_1", "tool_call_id": "toolu_1" }
            ],
            "required_action": {
                "submit_tool_outputs": {
                    "tool_calls": [
                        { "id": "toolu_1", "tool_call_id": "toolu_1" }
                    ]
                }
            }
        });
        normalize_responses_tool_call_ids_impl(&mut payload);
        assert!(payload["output"][0]["call_id"]
            .as_str()
            .unwrap()
            .starts_with("fc_"));
        assert!(payload["output"][0]["id"]
            .as_str()
            .unwrap()
            .starts_with("fc_"));
        assert!(
            payload["required_action"]["submit_tool_outputs"]["tool_calls"][0]["tool_call_id"]
                .as_str()
                .unwrap()
                .starts_with("fc_")
        );
    }

    #[test]
    fn strips_internal_tooling_metadata_fields() {
        let mut metadata = serde_json::json!({
            "toolCallIdStyle": "fc",
            "__rcc_raw_system": "keep out",
            "extraFields": {
                "__rcc_private": true,
                "safe": { "value": 1 }
            }
        });
        strip_internal_tooling_metadata_impl(&mut metadata);
        assert!(metadata.get("toolCallIdStyle").is_none());
        assert!(metadata.get("__rcc_raw_system").is_none());
        assert!(metadata["extraFields"].get("__rcc_private").is_none());
        assert_eq!(metadata["extraFields"]["safe"]["value"], 1);
    }

    #[test]
    fn resolves_tool_call_id_style_defaults_to_fc() {
        assert_eq!(
            resolve_tool_call_id_style_impl(&serde_json::json!({})),
            "fc"
        );
        assert_eq!(
            resolve_tool_call_id_style_impl(&serde_json::json!({"toolCallIdStyle": "preserve"})),
            "preserve"
        );
    }
}
