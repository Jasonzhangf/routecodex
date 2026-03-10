use serde_json::Value;

use super::super::read_trimmed_string;

fn read_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

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
        .map(|v| v.eq_ignore_ascii_case("response"))
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

fn try_unwrap_known_shape(value: &Value, depth: i32) -> Option<Value> {
    if depth < 0 {
        return None;
    }
    if looks_like_known_provider_response_shape(value) {
        return Some(value.clone());
    }
    let row = value.as_object()?;
    for key in ["data", "body", "response", "payload", "result", "biz_data"] {
        if let Some(next) = row.get(key) {
            if let Some(unwrapped) = try_unwrap_known_shape(next, depth - 1) {
                return Some(unwrapped);
            }
        }
    }
    None
}

pub(super) fn normalize_deepseek_business_envelope(payload: Value) -> Result<Value, String> {
    if looks_like_known_provider_response_shape(&payload) {
        return Ok(payload);
    }
    let Some(root) = payload.as_object() else {
        return Ok(payload);
    };
    if !(root.contains_key("code") && root.contains_key("data")) {
        return Ok(payload);
    }

    if let Some(data) = root.get("data") {
        if let Some(unwrapped) = try_unwrap_known_shape(data, 6) {
            return Ok(unwrapped);
        }
    }

    let data_node = root.get("data").and_then(|v| v.as_object());
    let upstream_code = read_number(root.get("code"));
    let biz_code = read_number(data_node.and_then(|v| v.get("biz_code")));
    let biz_msg = read_trimmed_string(data_node.and_then(|v| v.get("biz_msg")));
    let top_msg = read_trimmed_string(root.get("msg"));
    let has_error = upstream_code.map(|v| v != 0.0).unwrap_or(false)
        || biz_code.map(|v| v != 0.0).unwrap_or(false)
        || biz_msg.is_some()
        || top_msg.is_some();
    if has_error {
        let message = biz_msg
            .or(top_msg)
            .unwrap_or_else(|| "DeepSeek returned a non-chat business envelope".to_string());
        return Err(format!(
            "[deepseek-web] upstream business error: {}",
            message
        ));
    }

    Ok(payload)
}
