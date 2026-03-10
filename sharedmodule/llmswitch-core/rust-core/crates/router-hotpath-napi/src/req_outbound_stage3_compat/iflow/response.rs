use serde_json::Value;

use crate::resp_process_stage1_tool_governance::{govern_response, ToolGovernanceInput};

fn looks_like_known_provider_response_shape(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    if row.get("choices").and_then(|v| v.as_array()).is_some() {
        return true;
    }
    if row.get("output").and_then(|v| v.as_array()).is_some() {
        return true;
    }
    if row
        .get("object")
        .and_then(|v| v.as_str())
        .map(|v| v == "response")
        .unwrap_or(false)
    {
        return true;
    }
    if row
        .get("type")
        .and_then(|v| v.as_str())
        .map(|v| v.eq_ignore_ascii_case("message"))
        .unwrap_or(false)
        && row.get("content").and_then(|v| v.as_array()).is_some()
    {
        return true;
    }
    if row.get("candidates").and_then(|v| v.as_array()).is_some() {
        return true;
    }
    false
}

fn strip_json_text_prefix(text: &str) -> String {
    let mut out = text.trim_start().to_string();
    if out.starts_with(")]}'") {
        out = out
            .trim_start_matches(")]}'")
            .trim_start_matches(',')
            .trim_start()
            .to_string();
    }
    if out.to_ascii_lowercase().starts_with("data:") {
        out = out[5..].trim_start().to_string();
    }
    out
}

fn try_parse_json_record(text: &str) -> Option<Value> {
    let trimmed = strip_json_text_prefix(text).trim().to_string();
    if trimmed.is_empty() || trimmed.len() > 10 * 1024 * 1024 {
        return None;
    }
    let first = trimmed.chars().next()?;
    let last = trimmed.chars().last()?;
    if !((first == '{' || first == '[') && (last == '}' || last == ']')) {
        return None;
    }
    let parsed: Value = serde_json::from_str(&trimmed).ok()?;
    if parsed.is_object() {
        return Some(parsed);
    }
    None
}

fn try_parse_json_record_from_maybe_sse_text(raw: &str) -> Option<Value> {
    let cleaned = strip_json_text_prefix(raw);
    if cleaned.len() > 10 * 1024 * 1024 {
        return None;
    }
    if let Some(parsed) = try_parse_json_record(&cleaned) {
        return Some(parsed);
    }
    let lines: Vec<&str> = cleaned.lines().collect();
    for line in lines.iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower == "data: [done]" || lower == "[done]" {
            continue;
        }
        let candidate = if lower.starts_with("data:") {
            trimmed[5..].trim()
        } else {
            trimmed
        };
        if let Some(parsed) = try_parse_json_record(candidate) {
            return Some(parsed);
        }
    }
    None
}

fn try_unwrap_known_shape_from_body(value: &Value, depth: i32) -> Option<Value> {
    if depth < 0 {
        return None;
    }
    if looks_like_known_provider_response_shape(value) {
        return Some(value.clone());
    }
    if let Some(row) = value.as_object() {
        for key in ["data", "body", "response", "payload", "result"] {
            if let Some(next) = row.get(key) {
                if let Some(unwrapped) = try_unwrap_known_shape_from_body(next, depth - 1) {
                    return Some(unwrapped);
                }
            }
        }
        return None;
    }
    if let Some(raw) = value.as_str() {
        let parsed = try_parse_json_record(raw)
            .or_else(|| try_parse_json_record_from_maybe_sse_text(raw))?;
        return try_unwrap_known_shape_from_body(&parsed, depth - 1);
    }
    None
}

fn unwrap_iflow_response_body_envelope(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    if !root.contains_key("body") || !root.contains_key("status") || !root.contains_key("msg") {
        return Value::Object(root.clone());
    }
    if looks_like_known_provider_response_shape(&Value::Object(root.clone())) {
        return Value::Object(root.clone());
    }
    let Some(body) = root.get("body") else {
        return Value::Object(root.clone());
    };
    if let Some(unwrapped) = try_unwrap_known_shape_from_body(body, 6) {
        return unwrapped;
    }
    if body.is_object() {
        return body.clone();
    }
    if let Some(raw) = body.as_str() {
        if let Some(parsed) = try_parse_json_record_from_maybe_sse_text(raw) {
            return parsed;
        }
    }
    Value::Object(root.clone())
}

pub(crate) fn apply_iflow_response_compat(payload: Value, request_id: Option<&String>) -> Value {
    let unwrapped = unwrap_iflow_response_body_envelope(payload);
    match govern_response(ToolGovernanceInput {
        payload: unwrapped.clone(),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: request_id
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "req_iflow_compat".to_string()),
    }) {
        Ok(output) => output.governed_payload,
        Err(_) => unwrapped,
    }
}
