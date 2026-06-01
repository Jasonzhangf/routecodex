use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAX_PAYLOAD_SIZE_BYTES: usize = 50 * 1024 * 1024; // 50MB limit

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatBuildInput {
    pub format_envelope: Value,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatBuildOutput {
    pub payload: Value,
}

fn validate_payload_size(payload: &Value) -> Result<(), String> {
    let payload_str = match serde_json::to_string(payload) {
        Ok(s) => s,
        Err(e) => return Err(format!("Failed to serialize payload for size check: {}", e)),
    };

    if payload_str.len() > MAX_PAYLOAD_SIZE_BYTES {
        return Err(format!(
            "Payload size {} exceeds maximum allowed {} bytes",
            payload_str.len(),
            MAX_PAYLOAD_SIZE_BYTES
        ));
    }

    Ok(())
}

fn strip_private_fields(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (key, val) in map {
                // Strip private/internal control fields from provider outbound payloads.
                if key != "metadata" && !key.starts_with('_') {
                    new_map.insert(key.clone(), strip_private_fields(val));
                }
            }
            Value::Object(new_map)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(|v| strip_private_fields(v)).collect()),
        _ => value.clone(),
    }
}

fn chat_content_to_responses_content(content: &Value) -> Value {
    match content {
        Value::String(text) => Value::Array(vec![serde_json::json!({
            "type": "input_text",
            "text": text
        })]),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(strip_private_fields)
                .collect::<Vec<Value>>(),
        ),
        Value::Null => Value::Array(Vec::new()),
        other => Value::Array(vec![strip_private_fields(other)]),
    }
}

fn build_responses_input_from_chat_messages(messages: &[Value]) -> Value {
    Value::Array(
        messages
            .iter()
            .filter_map(|message| {
                let row = message.as_object()?;
                let role = row
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("user")
                    .trim();
                let content = row
                    .get("content")
                    .map(chat_content_to_responses_content)
                    .unwrap_or_else(|| Value::Array(Vec::new()));
                Some(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("message".to_string())),
                    (
                        "role".to_string(),
                        Value::String(if role.is_empty() { "user" } else { role }.to_string()),
                    ),
                    ("content".to_string(), content),
                ])))
            })
            .collect::<Vec<Value>>(),
    )
}

fn build_openai_responses_request(format_envelope: &Value) -> Result<Value, String> {
    let mut payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();

    if payload.get("input").is_none() {
        if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
            let mut responses_payload = Map::new();
            if let Some(model) = payload.get("model") {
                responses_payload.insert("model".to_string(), model.clone());
            }
            responses_payload.insert(
                "input".to_string(),
                build_responses_input_from_chat_messages(messages),
            );
            for key in [
                "tools",
                "tool_choice",
                "temperature",
                "top_p",
                "max_output_tokens",
                "max_tokens",
                "stream",
                "parallel_tool_calls",
                "user",
                "logit_bias",
                "seed",
                "response_format",
            ] {
                if let Some(value) = payload.get(key) {
                    responses_payload.insert(key.to_string(), value.clone());
                }
            }
            payload = Value::Object(responses_payload);
        }
    }

    // Ensure required fields for OpenAI Responses format
    if let Some(obj) = payload.as_object_mut() {
        // Remove any private fields
        let stripped = strip_private_fields(&Value::Object(obj.clone()));
        *obj = stripped.as_object().unwrap().clone();
    }

    Ok(payload)
}

fn build_openai_chat_request(format_envelope: &Value) -> Result<Value, String> {
    let mut payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();
    if payload.get("input").is_some() {
        let converted = crate::responses_openai_codec::run_responses_openai_request_codec_json(
            payload.to_string(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let converted_value: Value =
            serde_json::from_str(&converted).map_err(|error| error.to_string())?;
        return converted_value
            .get("request")
            .cloned()
            .ok_or_else(|| "responses-openai request codec returned no request".to_string());
    }
    if payload.get("messages").is_some() {
        return Ok(strip_private_fields(&payload));
    }
    Ok(strip_private_fields(&payload))
}

fn build_anthropic_messages_request(format_envelope: &Value) -> Result<Value, String> {
    let payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();

    if payload.get("input").is_some() {
        let chat = crate::responses_openai_codec::run_responses_openai_request_codec_json(
            payload.to_string(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let chat_value: Value = serde_json::from_str(&chat).map_err(|error| error.to_string())?;
        let chat_request = chat_value
            .get("request")
            .cloned()
            .ok_or_else(|| "responses-openai request codec returned no request".to_string())?;
        let anthropic = crate::anthropic_openai_codec::build_anthropic_from_openai_chat_json(
            chat_request.to_string(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let anthropic_value: Value =
            serde_json::from_str(&anthropic).map_err(|error| error.to_string())?;
        return Ok(strip_private_fields(&anthropic_value));
    }
    Ok(strip_private_fields(&payload))
}

fn build_gemini_chat_request(format_envelope: &Value) -> Result<Value, String> {
    let mut payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();

    if let Some(obj) = payload.as_object_mut() {
        let stripped = strip_private_fields(&Value::Object(obj.clone()));
        *obj = stripped.as_object().unwrap().clone();
    }

    Ok(payload)
}

pub fn build_format_request(input: FormatBuildInput) -> Result<FormatBuildOutput, String> {
    let payload = match input.protocol.as_str() {
        "openai-chat" => build_openai_chat_request(&input.format_envelope)?,
        "openai-responses" => build_openai_responses_request(&input.format_envelope)?,
        "anthropic-messages" => build_anthropic_messages_request(&input.format_envelope)?,
        "gemini-chat" => build_gemini_chat_request(&input.format_envelope)?,
        _ => {
            // Default fallback - just strip private fields
            let payload = input
                .format_envelope
                .get("payload")
                .ok_or("Missing 'payload' field in format envelope")?;
            strip_private_fields(payload)
        }
    };

    validate_payload_size(&payload)?;

    Ok(FormatBuildOutput { payload })
}

#[napi]
pub fn build_format_request_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: FormatBuildInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = build_format_request(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_openai_responses_request() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "messages": [{"role": "user", "content": "hello"}]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("model").is_some());
        assert_eq!(result.payload["model"], "gpt-4");
        assert!(result.payload.get("messages").is_none());
        assert_eq!(result.payload["input"][0]["type"], "message");
        assert_eq!(result.payload["input"][0]["role"], "user");
        assert_eq!(result.payload["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(result.payload["input"][0]["content"][0]["text"], "hello");
    }

    #[test]
    fn test_build_anthropic_messages_request() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "anthropic-messages",
                "version": "v1",
                "payload": {
                    "model": "claude-3-opus"
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(result.payload["model"], "claude-3-opus");
        assert!(result.payload.get("max_tokens").is_none());
    }

    #[test]
    fn test_build_gemini_chat_request() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "gemini-chat",
                "version": "v1",
                "payload": {
                    "model": "gemini-pro",
                    "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
                }
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(result.payload["model"], "gemini-pro");
    }

    #[test]
    fn test_strip_private_fields() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "_private": "should_be_stripped",
                    "__internal": "also_stripped",
                    "messages": [{"role": "user", "content": "hello", "_temp": "strip_me"}]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("_private").is_none());
        assert!(result.payload.get("__internal").is_none());
        assert!(result.payload.get("model").is_some());

        assert!(result.payload.get("messages").is_none());
        assert!(result.payload["input"][0]["content"][0].get("_temp").is_none());
    }

    #[test]
    fn test_provider_outbound_strips_metadata_field() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-chat",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "messages": [{"role": "user", "content": "hello"}],
                    "metadata": {"user_id": "must-not-leak"}
                }
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("metadata").is_none());
    }

    #[test]
    fn test_provider_outbound_does_not_backfill_from_metadata_context() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "metadata": {
                        "context": {
                            "input": [{"role": "user", "content": [{"type": "input_text", "text": "must not backfill"}]}],
                            "toolsRaw": [{"type": "function", "name": "leak"}]
                        }
                    }
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("metadata").is_none());
        assert!(result.payload.get("input").is_none());
        assert!(result.payload.get("tools").is_none());
    }

    #[test]
    fn test_error_missing_payload() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses"
            }),
            protocol: "openai-responses".to_string(),
        };

        let err = build_format_request(input).unwrap_err();
        assert_eq!(err, "Missing 'payload' field in format envelope");
    }

    #[test]
    fn test_error_empty_json_input() {
        let result = build_format_request_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    #[test]
    fn test_error_invalid_json_input() {
        let result = build_format_request_json("not valid json".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_payload_size_limit() {
        let small_payload = serde_json::json!({"model": "test"});
        assert!(validate_payload_size(&small_payload).is_ok());
    }

    // Critical path test: Protocol not found fallback
    #[test]
    fn test_unknown_protocol_fallback() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "unknown-protocol",
                "version": "v1",
                "payload": {
                    "model": "test-model",
                    "_private": "should_be_stripped"
                }
            }),
            protocol: "unknown-protocol".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(result.payload["model"], "test-model");
        assert!(result.payload.get("_private").is_none());
    }

    // Critical path test: Nested private fields in arrays
    #[test]
    fn test_nested_private_fields_in_array() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "payload": {
                    "messages": [
                        {"role": "user", "content": "hello", "_temp_id": "123"},
                        {"role": "assistant", "content": "hi", "__internal_cache": "xyz"}
                    ]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        if let Some(input) = result.payload.get("input").and_then(|v| v.as_array()) {
            for msg in input {
                assert!(msg.get("_temp_id").is_none());
                assert!(msg.get("__internal_cache").is_none());
            }
        }
    }
}
