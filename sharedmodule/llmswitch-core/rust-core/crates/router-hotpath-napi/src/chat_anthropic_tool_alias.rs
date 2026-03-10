use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn normalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mcp__") {
        return Some(lower);
    }
    Some(lower)
}

fn read_name(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    let raw = obj.get("name")?.as_str()?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

#[napi]
pub fn build_anthropic_tool_alias_map_json(raw_tools_json: String) -> NapiResult<String> {
    let raw_tools: Value = serde_json::from_str(&raw_tools_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let rows = match raw_tools.as_array() {
        Some(v) if !v.is_empty() => v,
        _ => {
            return Ok("null".to_string());
        }
    };

    let mut alias_map: Map<String, Value> = Map::new();
    for entry in rows {
        let raw_name = match read_name(entry) {
            Some(v) => v,
            None => continue,
        };
        let normalized =
            normalize_anthropic_tool_name(raw_name.as_str()).unwrap_or(raw_name.clone());
        let canonical_key = normalized.trim().to_string();
        if canonical_key.is_empty() {
            continue;
        }

        alias_map.insert(canonical_key.clone(), Value::String(raw_name.clone()));
        let lower_key = canonical_key.to_ascii_lowercase();
        if lower_key != canonical_key && !alias_map.contains_key(lower_key.as_str()) {
            alias_map.insert(lower_key, Value::String(raw_name));
        }
    }

    if alias_map.is_empty() {
        return Ok("null".to_string());
    }

    serde_json::to_string(&Value::Object(alias_map))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
