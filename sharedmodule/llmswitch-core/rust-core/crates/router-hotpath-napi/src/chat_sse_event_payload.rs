use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

fn current_unix_timestamp_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Chat SSE event clock before UNIX_EPOCH: {}", error))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| "Chat SSE event timestamp overflow".to_string())
}

pub fn build_chat_sse_event_envelope_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Chat SSE event envelope JSON: {}", error))?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE event envelope expected object".to_string());
    };
    let request_id = input
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Chat SSE event envelope missing request_id".to_string())?;
    let current_sequence = input
        .get("current_sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Chat SSE event envelope missing current_sequence".to_string())?;
    if current_sequence < 0 {
        return Err("Chat SSE event envelope current_sequence must be non-negative".to_string());
    }
    let enable_timestamp_generation = input
        .get("enable_timestamp_generation")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let enable_sequence_numbers = input
        .get("enable_sequence_numbers")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let sequence_number = if enable_sequence_numbers {
        current_sequence
    } else {
        0
    };
    let next_sequence_counter = if enable_sequence_numbers {
        current_sequence + 1
    } else {
        current_sequence
    };
    let timestamp = if enable_timestamp_generation {
        current_unix_timestamp_ms()?
    } else {
        0
    };

    serde_json::to_string(&serde_json::json!({
        "requestId": request_id,
        "timestamp": timestamp,
        "sequenceNumber": sequence_number,
        "nextSequenceCounter": next_sequence_counter,
        "protocol": "chat",
        "direction": "json_to_sse"
    }))
    .map_err(|error| format!("Failed to serialize Chat SSE event envelope JSON: {}", error))
}

pub fn build_chat_sse_error_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Chat SSE error payload JSON: {}", error))?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE error payload expected object".to_string());
    };
    let message = input
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Chat SSE error payload missing message".to_string())?;

    serde_json::to_string(&serde_json::json!({
        "error": {
            "message": message,
            "type": "internal_error",
            "code": "generation_error"
        }
    }))
    .map_err(|error| format!("Failed to serialize Chat SSE error payload JSON: {}", error))
}

fn read_required_string<'a>(
    row: &'a serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a str, String> {
    row.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Chat SSE {} missing {}", label, field))
}

fn read_required_i64(
    row: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<i64, String> {
    row.get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Chat SSE {} missing {}", label, field))
}

pub fn build_chat_sse_role_delta_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Chat SSE role delta payload JSON: {}", error))?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE role delta payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "role delta payload")?;
    let model = read_required_string(input, "model", "role delta payload")?;
    let role = read_required_string(input, "role", "role delta payload")?;
    match role {
        "user" | "system" | "assistant" | "tool" => {}
        _ => return Err(format!("Chat SSE role delta payload invalid role: {}", role)),
    }
    let created = read_required_i64(input, "created", "role delta payload")?;
    if created <= 0 {
        return Err("Chat SSE role delta payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "role delta payload")?;
    if choice_index < 0 {
        return Err("Chat SSE role delta payload choice_index must be non-negative".to_string());
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": { "role": role },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| format!("Failed to serialize Chat SSE role delta payload JSON: {}", error))
}

pub fn build_chat_sse_content_delta_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Chat SSE content delta payload JSON: {}", error))?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE content delta payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "content delta payload")?;
    let model = read_required_string(input, "model", "content delta payload")?;
    let content = read_required_string(input, "content", "content delta payload")?;
    let created = read_required_i64(input, "created", "content delta payload")?;
    if created <= 0 {
        return Err("Chat SSE content delta payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "content delta payload")?;
    if choice_index < 0 {
        return Err("Chat SSE content delta payload choice_index must be non-negative".to_string());
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": { "content": content },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| format!("Failed to serialize Chat SSE content delta payload JSON: {}", error))
}

pub fn build_chat_sse_reasoning_delta_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Chat SSE reasoning delta payload JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE reasoning delta payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "reasoning delta payload")?;
    let model = read_required_string(input, "model", "reasoning delta payload")?;
    let reasoning = read_required_string(input, "reasoning", "reasoning delta payload")?;
    let created = read_required_i64(input, "created", "reasoning delta payload")?;
    if created <= 0 {
        return Err("Chat SSE reasoning delta payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "reasoning delta payload")?;
    if choice_index < 0 {
        return Err("Chat SSE reasoning delta payload choice_index must be non-negative".to_string());
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": {
                "reasoning": reasoning,
                "reasoning_content": reasoning
            },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| format!("Failed to serialize Chat SSE reasoning delta payload JSON: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn builds_chat_sse_event_envelope_and_advances_sequence() {
        let output = build_chat_sse_event_envelope_json(
            json!({
                "request_id": "req_chat_envelope",
                "current_sequence": 4,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": true
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["requestId"], json!("req_chat_envelope"));
        assert_eq!(parsed["timestamp"], json!(0));
        assert_eq!(parsed["sequenceNumber"], json!(4));
        assert_eq!(parsed["nextSequenceCounter"], json!(5));
        assert_eq!(parsed["protocol"], json!("chat"));
        assert_eq!(parsed["direction"], json!("json_to_sse"));
    }

    #[test]
    fn builds_chat_sse_event_envelope_without_sequence_generation() {
        let output = build_chat_sse_event_envelope_json(
            json!({
                "request_id": "req_chat_envelope_no_sequence",
                "current_sequence": 4,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": false
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["sequenceNumber"], json!(0));
        assert_eq!(parsed["nextSequenceCounter"], json!(4));
    }

    #[test]
    fn rejects_chat_sse_event_envelope_missing_request_id() {
        let err = build_chat_sse_event_envelope_json(
            json!({
                "current_sequence": 0,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": true
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing request_id"));
    }

    #[test]
    fn builds_chat_sse_error_payload() {
        let output = build_chat_sse_error_payload_json(
            json!({
                "message": "Invalid ChatCompletionResponse: missing choices"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(
            parsed,
            json!({
                "error": {
                    "message": "Invalid ChatCompletionResponse: missing choices",
                    "type": "internal_error",
                    "code": "generation_error"
                }
            })
        );
    }

    #[test]
    fn rejects_chat_sse_error_payload_missing_message() {
        let err = build_chat_sse_error_payload_json(json!({}).to_string()).unwrap_err();

        assert!(err.contains("missing message"));
    }

    #[test]
    fn builds_chat_sse_role_delta_payload() {
        let output = build_chat_sse_role_delta_payload_json(
            json!({
                "response_id": "chatcmpl_role_delta",
                "created": 1782778486,
                "model": "gpt-test",
                "choice_index": 0,
                "role": "assistant"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_role_delta"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778486));
        assert_eq!(parsed["model"], json!("gpt-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(0));
        assert_eq!(parsed["choices"][0]["delta"]["role"], json!("assistant"));
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_role_delta_payload_invalid_role() {
        let err = build_chat_sse_role_delta_payload_json(
            json!({
                "response_id": "chatcmpl_role_delta",
                "created": 1782778486,
                "model": "gpt-test",
                "choice_index": 0,
                "role": "invalid"
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("invalid role"));
    }

    #[test]
    fn builds_chat_sse_content_delta_payload() {
        let output = build_chat_sse_content_delta_payload_json(
            json!({
                "response_id": "chatcmpl_content_delta",
                "created": 1782778487,
                "model": "gpt-test",
                "choice_index": 1,
                "content": "hello world"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_content_delta"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778487));
        assert_eq!(parsed["model"], json!("gpt-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(1));
        assert_eq!(parsed["choices"][0]["delta"]["content"], json!("hello world"));
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_content_delta_payload_missing_content() {
        let err = build_chat_sse_content_delta_payload_json(
            json!({
                "response_id": "chatcmpl_content_delta",
                "created": 1782778487,
                "model": "gpt-test",
                "choice_index": 1
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing content"));
    }

    #[test]
    fn builds_chat_sse_reasoning_delta_payload() {
        let output = build_chat_sse_reasoning_delta_payload_json(
            json!({
                "response_id": "chatcmpl_reasoning_delta",
                "created": 1782778488,
                "model": "qwen-test",
                "choice_index": 0,
                "reasoning": "先检查上下文"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_reasoning_delta"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778488));
        assert_eq!(parsed["model"], json!("qwen-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(0));
        assert_eq!(parsed["choices"][0]["delta"]["reasoning"], json!("先检查上下文"));
        assert_eq!(
            parsed["choices"][0]["delta"]["reasoning_content"],
            json!("先检查上下文")
        );
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_reasoning_delta_payload_missing_reasoning() {
        let err = build_chat_sse_reasoning_delta_payload_json(
            json!({
                "response_id": "chatcmpl_reasoning_delta",
                "created": 1782778488,
                "model": "qwen-test",
                "choice_index": 0
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing reasoning"));
    }
}
