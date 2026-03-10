use napi::bindgen_prelude::Result as NapiResult;
use serde_json::Value;

fn has_compaction_marker(value: &str) -> bool {
    let lower = value.trim_start().to_lowercase();
    lower.starts_with("context checkpoint compaction")
        || lower.starts_with("checkpoint compaction")
        || lower.starts_with("handoff summary for another llm")
}

fn contains_marker(value: &Value) -> bool {
    match value {
        Value::String(text) => has_compaction_marker(text),
        Value::Array(entries) => entries.iter().any(contains_marker),
        Value::Object(row) => {
            if row
                .get("text")
                .and_then(Value::as_str)
                .map(has_compaction_marker)
                .unwrap_or(false)
            {
                return true;
            }
            if row
                .get("content")
                .and_then(Value::as_str)
                .map(has_compaction_marker)
                .unwrap_or(false)
            {
                return true;
            }
            if row
                .get("content")
                .and_then(Value::as_array)
                .map(|parts| parts.iter().any(contains_marker))
                .unwrap_or(false)
            {
                return true;
            }
            row.get("parts")
                .and_then(Value::as_array)
                .map(|parts| parts.iter().any(contains_marker))
                .unwrap_or(false)
        }
        _ => false,
    }
}

fn is_compaction_request(payload: &Value) -> bool {
    if contains_marker(payload) {
        return true;
    }
    let row = match payload.as_object() {
        Some(v) => v,
        None => return false,
    };
    if row
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| messages.iter().any(contains_marker))
        .unwrap_or(false)
    {
        return true;
    }
    if row.get("input").map(contains_marker).unwrap_or(false) {
        return true;
    }
    if row.get("system").map(contains_marker).unwrap_or(false) {
        return true;
    }
    row.get("instructions")
        .map(contains_marker)
        .unwrap_or(false)
}

#[napi_derive::napi]
pub fn is_compaction_request_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_compaction_request(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
