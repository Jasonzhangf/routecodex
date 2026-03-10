use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn read_finite_floor_i64(value: Option<&Value>) -> Option<i64> {
    let raw = match value {
        Some(v) => v,
        None => return None,
    };
    let as_number = if let Some(v) = raw.as_f64() {
        Some(v)
    } else if let Some(v) = raw.as_str() {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            trimmed.parse::<f64>().ok()
        }
    } else {
        None
    };
    as_number.and_then(|v| {
        if v.is_finite() {
            Some(v.floor() as i64)
        } else {
            None
        }
    })
}

fn extract_sse_wrapper_error_from_record(
    record: &Map<String, Value>,
    depth: i32,
) -> Option<String> {
    if depth < 0 {
        return None;
    }
    let mode = record.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    let err = record.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let err_trimmed = err.trim();
    if mode == "sse" && !err_trimmed.is_empty() {
        return Some(err_trimmed.to_string());
    }
    for key in ["body", "data", "payload", "response"] {
        if let Some(nested) = record.get(key).and_then(|v| v.as_object()) {
            if let Some(found) = extract_sse_wrapper_error_from_record(nested, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn extract_sse_wrapper_error(payload: &Value) -> Option<String> {
    let record = payload.as_object()?;
    extract_sse_wrapper_error_from_record(record, 2)
}

fn extract_context_length_diagnostics(adapter_context: &Value) -> Map<String, Value> {
    let mut output = Map::<String, Value>::new();
    let ctx = match adapter_context.as_object() {
        Some(v) => v,
        None => return output,
    };
    let runtime_node = ctx.get("__rt").and_then(|v| v.as_object());
    let target_node = ctx.get("target").and_then(|v| v.as_object());

    let estimated_prompt_tokens = read_finite_floor_i64(ctx.get("estimatedInputTokens"))
        .or_else(|| read_finite_floor_i64(ctx.get("requestTokens")))
        .or_else(|| read_finite_floor_i64(ctx.get("reqTokens")))
        .or_else(|| {
            runtime_node.and_then(|node| read_finite_floor_i64(node.get("estimatedInputTokens")))
        })
        .or_else(|| runtime_node.and_then(|node| read_finite_floor_i64(node.get("requestTokens"))))
        .or_else(|| runtime_node.and_then(|node| read_finite_floor_i64(node.get("reqTokens"))));

    let max_context_tokens = target_node
        .and_then(|node| read_finite_floor_i64(node.get("maxContextTokens")))
        .or_else(|| read_finite_floor_i64(ctx.get("maxContextTokens")))
        .or_else(|| {
            runtime_node.and_then(|node| read_finite_floor_i64(node.get("maxContextTokens")))
        });

    if let Some(v) = estimated_prompt_tokens {
        output.insert("estimatedPromptTokens".to_string(), Value::from(v));
    }
    if let Some(v) = max_context_tokens {
        output.insert("maxContextTokens".to_string(), Value::from(v));
    }
    output
}

fn is_context_length_exceeded_signal(code: &str, message: &str, context: &Value) -> bool {
    let code_lower = code.trim().to_ascii_lowercase();
    if code_lower.contains("context_length_exceeded") {
        return true;
    }
    let message_lower = message.to_ascii_lowercase();
    if message_lower.contains("context_length_exceeded")
        || message.contains("达到对话长度上限")
        || message.contains("对话长度上限")
    {
        return true;
    }
    let finish_reason = context
        .as_object()
        .and_then(|obj| obj.get("errorData"))
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("finish_reason"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    finish_reason == "context_length_exceeded"
}

#[napi]
pub fn extract_sse_wrapper_error_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_sse_wrapper_error(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn extract_context_length_diagnostics_json(adapter_context_json: String) -> NapiResult<String> {
    let adapter_context: Value = serde_json::from_str(&adapter_context_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_context_length_diagnostics(&adapter_context);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_context_length_exceeded_signal_json(
    code: String,
    message: String,
    context_json: String,
) -> NapiResult<String> {
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_context_length_exceeded_signal(&code, &message, &context);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
