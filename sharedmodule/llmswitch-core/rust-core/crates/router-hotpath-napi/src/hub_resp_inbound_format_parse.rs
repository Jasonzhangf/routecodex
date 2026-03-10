use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_PAYLOAD_SIZE_BYTES: usize = 50 * 1024 * 1024; // 50MB limit

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespFormatParseInput {
    pub payload: Value,
    pub protocol: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatEnvelope {
    pub format: String,
    pub version: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespFormatParseOutput {
    pub envelope: FormatEnvelope,
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

fn parse_openai_responses_response(payload: &Value) -> Result<FormatEnvelope, String> {
    validate_payload_size(payload)?;

    // Extract model from response if available
    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "openai-responses".to_string(),
        version: "v1".to_string(),
        payload: payload.clone(),
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "resp_format_parse"
        })),
    })
}

fn parse_anthropic_messages_response(payload: &Value) -> Result<FormatEnvelope, String> {
    validate_payload_size(payload)?;

    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "anthropic-messages".to_string(),
        version: "v1".to_string(),
        payload: payload.clone(),
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "resp_format_parse"
        })),
    })
}

fn parse_gemini_chat_response(payload: &Value) -> Result<FormatEnvelope, String> {
    validate_payload_size(payload)?;

    // Gemini response model might be in different locations
    let model = payload
        .get("modelVersion")
        .or_else(|| payload.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "gemini-chat".to_string(),
        version: "v1".to_string(),
        payload: payload.clone(),
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "resp_format_parse"
        })),
    })
}

pub fn parse_resp_format_envelope(
    input: RespFormatParseInput,
) -> Result<RespFormatParseOutput, String> {
    let envelope = match input.protocol.as_str() {
        "openai-responses" => parse_openai_responses_response(&input.payload)?,
        "anthropic-messages" => parse_anthropic_messages_response(&input.payload)?,
        "gemini-chat" => parse_gemini_chat_response(&input.payload)?,
        _ => {
            // Default fallback - create generic envelope
            FormatEnvelope {
                format: input.protocol.clone(),
                version: "v1".to_string(),
                payload: input.payload.clone(),
                metadata: Some(serde_json::json!({
                    "extracted_at": "resp_format_parse"
                })),
            }
        }
    };

    Ok(RespFormatParseOutput { envelope })
}

#[napi]
pub fn parse_resp_format_envelope_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: RespFormatParseInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = parse_resp_format_envelope(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_openai_responses_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_123",
                "model": "gpt-4",
                "output": [{"type": "message", "content": "hello"}]
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert_eq!(result.envelope.version, "v1");
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "gpt-4");
    }

    #[test]
    fn test_parse_anthropic_messages_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "msg_123",
                "model": "claude-3-opus",
                "content": [{"type": "text", "text": "hello"}],
                "stop_reason": "end_turn"
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "anthropic-messages");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "claude-3-opus"
        );
    }

    #[test]
    fn test_parse_gemini_chat_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "candidates": [{"content": {"parts": [{"text": "hello"}]}}],
                "modelVersion": "gemini-pro"
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "gemini-chat");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "gemini-pro"
        );
    }

    #[test]
    fn test_parse_gemini_chat_response_fallback_model() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "candidates": [{"content": {"parts": [{"text": "hello"}]}}],
                "model": "gemini-flash"
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        // Should fall back to "model" field if "modelVersion" not present
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "gemini-flash"
        );
    }

    #[test]
    fn test_unknown_protocol_fallback() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "custom_field": "value"
            }),
            protocol: "custom-protocol".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "custom-protocol");
        assert_eq!(result.envelope.version, "v1");
    }

    #[test]
    fn test_error_empty_json_input() {
        let result = parse_resp_format_envelope_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    #[test]
    fn test_error_invalid_json_input() {
        let result = parse_resp_format_envelope_json("not valid json".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_payload_size_limit() {
        let small_payload = serde_json::json!({"test": "data"});
        assert!(validate_payload_size(&small_payload).is_ok());
    }

    // Critical path test: Missing model field (should not fail, just empty string)
    #[test]
    fn test_missing_model_field() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_123",
                "output": []
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        // Model should be empty string when not present
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "");
    }

    // Critical path test: Model field is not string type
    #[test]
    fn test_model_field_not_string() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_123",
                "model": 123
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        // Should handle gracefully with empty string
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "");
    }

    // Critical path test: Large response payload
    #[test]
    fn test_large_response_payload() {
        let mut content_parts = Vec::new();
        for i in 0..100 {
            content_parts.push(serde_json::json!({
                "type": "text",
                "text": format!("Content block {} with some text", i)
            }));
        }

        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_large",
                "model": "gpt-4",
                "output": content_parts
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
    }
}
