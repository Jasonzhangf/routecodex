use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RespInboundSseErrorDescriptor {
    code: String,
    protocol: String,
    provider_type: Option<String>,
    error_message: String,
    details: Map<String, Value>,
    stage_record: Map<String, Value>,
    status: Option<i64>,
}

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

fn resolve_provider_type(protocol: &str) -> Option<String> {
    match protocol {
        "openai-chat" => Some("openai".to_string()),
        "openai-responses" => Some("responses".to_string()),
        "anthropic-messages" => Some("anthropic".to_string()),
        "gemini-chat" => Some("gemini".to_string()),
        _ => None,
    }
}

fn is_retryable_network_sse_decode_failure(message: &str, upstream_code: &str) -> bool {
    let normalized_message = message.trim().to_ascii_lowercase();
    let normalized_upstream_code = upstream_code.trim().to_ascii_lowercase();
    normalized_message.contains("internal network failure")
        || normalized_message.contains("network failure")
        || normalized_message.contains("network error")
        || normalized_message.contains("service unavailable")
        || normalized_message.contains("temporarily unavailable")
        || normalized_message.contains("timeout")
        || normalized_upstream_code.contains("anthropic_sse_to_json_failed")
}

fn build_resp_inbound_sse_error_descriptor(
    input: &Value,
) -> std::result::Result<RespInboundSseErrorDescriptor, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "expected object input".to_string())?;
    let kind = row
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "missing kind".to_string())?;
    let protocol = row
        .get("providerProtocol")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "missing providerProtocol".to_string())?;
    let request_id = row
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let provider_type = resolve_provider_type(&protocol);
    let mut details = Map::<String, Value>::new();
    details.insert(
        "phase".to_string(),
        Value::String("chat_process.resp.stage1.sse_decode".to_string()),
    );
    if let Some(request_id) = request_id {
        details.insert("requestId".to_string(), Value::String(request_id));
    }

    match kind.as_str() {
        "wrapper_error" => {
            let wrapper_error = row
                .get("wrapperError")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "missing wrapperError".to_string())?;
            details.insert("message".to_string(), Value::String(wrapper_error.clone()));
            let mut stage_record = Map::<String, Value>::new();
            stage_record.insert(
                "reason".to_string(),
                Value::String("sse_wrapper_error".to_string()),
            );
            stage_record.insert("error".to_string(), Value::String(wrapper_error.clone()));
            Ok(RespInboundSseErrorDescriptor {
                code: "SSE_DECODE_ERROR".to_string(),
                protocol,
                provider_type,
                error_message: format!(
                    "[chat_process.resp.stage1.sse_decode] Upstream SSE terminated: {wrapper_error}"
                ),
                details,
                stage_record,
                status: None,
            })
        }
        "protocol_unsupported" => {
            details.insert(
                "reason".to_string(),
                Value::String("protocol_unsupported".to_string()),
            );
            let mut stage_record = Map::<String, Value>::new();
            stage_record.insert(
                "reason".to_string(),
                Value::String("protocol_unsupported".to_string()),
            );
            Ok(RespInboundSseErrorDescriptor {
                code: "SSE_DECODE_ERROR".to_string(),
                protocol: protocol.clone(),
                provider_type,
                error_message: format!(
                    "[chat_process.resp.stage1.sse_decode] Protocol {protocol} does not support SSE decoding"
                ),
                details,
                stage_record,
                status: None,
            })
        }
        "decode_failure" => {
            let message = row
                .get("message")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .ok_or_else(|| "missing message".to_string())?;
            let upstream_code = row
                .get("upstreamCode")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_default();
            let upstream_context = row.get("upstreamContext").cloned().unwrap_or(Value::Null);
            let adapter_context = row.get("adapterContext").cloned().unwrap_or(Value::Null);
            let context_length_exceeded =
                is_context_length_exceeded_signal(&upstream_code, &message, &upstream_context);
            let retryable_network_failure = !context_length_exceeded
                && protocol == "anthropic-messages"
                && is_retryable_network_sse_decode_failure(&message, &upstream_code);
            let diagnostics = extract_context_length_diagnostics(&adapter_context);

            details.insert("message".to_string(), Value::String(message.clone()));
            if retryable_network_failure {
                details.insert("statusCode".to_string(), Value::from(502));
                details.insert("status".to_string(), Value::from(502));
                details.insert("retryable".to_string(), Value::Bool(true));
            }
            if !upstream_code.is_empty() {
                details.insert(
                    "upstreamCode".to_string(),
                    Value::String(upstream_code.clone()),
                );
            }
            if context_length_exceeded {
                details.insert(
                    "reason".to_string(),
                    Value::String("context_length_exceeded".to_string()),
                );
            }
            for (key, value) in diagnostics.iter() {
                details.insert(key.clone(), value.clone());
            }

            let mut stage_record = Map::<String, Value>::new();
            stage_record.insert("error".to_string(), Value::String(message.clone()));
            if !upstream_code.is_empty() {
                stage_record.insert("upstreamCode".to_string(), Value::String(upstream_code));
            }
            if retryable_network_failure {
                stage_record.insert("statusCode".to_string(), Value::from(502));
            }
            if context_length_exceeded {
                stage_record.insert(
                    "reason".to_string(),
                    Value::String("context_length_exceeded".to_string()),
                );
            }
            for (key, value) in diagnostics {
                stage_record.insert(key, value);
            }

            Ok(RespInboundSseErrorDescriptor {
                code: if retryable_network_failure {
                    "HTTP_502".to_string()
                } else {
                    "SSE_DECODE_ERROR".to_string()
                },
                protocol,
                provider_type,
                error_message: format!(
                    "[chat_process.resp.stage1.sse_decode] Failed to decode SSE payload for protocol {}: {}{}",
                    row.get("providerProtocol")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    message,
                    if context_length_exceeded {
                        " (context too long; please compress conversation context and retry)"
                    } else {
                        ""
                    }
                ),
                details,
                stage_record,
                status: if retryable_network_failure { Some(502) } else { None },
            })
        }
        _ => Err("unsupported kind".to_string()),
    }
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

#[napi]
pub fn build_resp_inbound_sse_error_descriptor_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        build_resp_inbound_sse_error_descriptor(&input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_wrapper_error_descriptor() {
        let descriptor = build_resp_inbound_sse_error_descriptor(&json!({
            "kind": "wrapper_error",
            "providerProtocol": "openai-chat",
            "requestId": "req-1",
            "wrapperError": "stream closed"
        }))
        .expect("descriptor");

        assert_eq!(descriptor.code, "SSE_DECODE_ERROR");
        assert_eq!(descriptor.protocol, "openai-chat");
        assert_eq!(descriptor.provider_type.as_deref(), Some("openai"));
        assert_eq!(
            descriptor.details.get("requestId"),
            Some(&Value::String("req-1".to_string()))
        );
        assert_eq!(
            descriptor.details.get("message"),
            Some(&Value::String("stream closed".to_string()))
        );
        assert_eq!(
            descriptor.stage_record.get("reason"),
            Some(&Value::String("sse_wrapper_error".to_string()))
        );
    }

    #[test]
    fn builds_retryable_anthropic_decode_failure_descriptor() {
        let descriptor = build_resp_inbound_sse_error_descriptor(&json!({
            "kind": "decode_failure",
            "providerProtocol": "anthropic-messages",
            "requestId": "req-2",
            "message": "internal network failure while streaming",
            "upstreamCode": "anthropic_sse_to_json_failed",
            "adapterContext": {
                "estimatedInputTokens": 1234,
                "maxContextTokens": 4096
            }
        }))
        .expect("descriptor");

        assert_eq!(descriptor.code, "HTTP_502");
        assert_eq!(descriptor.status, Some(502));
        assert_eq!(
            descriptor.details.get("retryable"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            descriptor.details.get("statusCode"),
            Some(&Value::from(502))
        );
        assert_eq!(
            descriptor.stage_record.get("statusCode"),
            Some(&Value::from(502))
        );
        assert_eq!(
            descriptor.stage_record.get("estimatedPromptTokens"),
            Some(&Value::from(1234))
        );
        assert_eq!(
            descriptor.stage_record.get("maxContextTokens"),
            Some(&Value::from(4096))
        );
    }

    #[test]
    fn builds_context_length_exceeded_descriptor() {
        let descriptor = build_resp_inbound_sse_error_descriptor(&json!({
            "kind": "decode_failure",
            "providerProtocol": "anthropic-messages",
            "requestId": "req-3",
            "message": "达到对话长度上限",
            "upstreamCode": "provider_decode_failed",
            "upstreamContext": {
                "errorData": {
                    "finish_reason": "context_length_exceeded"
                }
            },
            "adapterContext": {
                "estimatedInputTokens": 8192,
                "target": {
                    "maxContextTokens": 4096
                }
            }
        }))
        .expect("descriptor");

        assert_eq!(descriptor.code, "SSE_DECODE_ERROR");
        assert_eq!(descriptor.status, None);
        assert_eq!(
            descriptor.details.get("reason"),
            Some(&Value::String("context_length_exceeded".to_string()))
        );
        assert!(descriptor
            .error_message
            .contains("context too long; please compress conversation context and retry"));
        assert_eq!(
            descriptor.stage_record.get("reason"),
            Some(&Value::String("context_length_exceeded".to_string()))
        );
        assert_eq!(
            descriptor.stage_record.get("estimatedPromptTokens"),
            Some(&Value::from(8192))
        );
        assert_eq!(
            descriptor.stage_record.get("maxContextTokens"),
            Some(&Value::from(4096))
        );
    }
}
