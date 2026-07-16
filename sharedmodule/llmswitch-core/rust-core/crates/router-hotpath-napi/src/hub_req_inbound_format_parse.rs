use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatParseInput {
    pub raw_request: Value,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatEnvelope {
    pub format: String,
    pub version: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatParseOutput {
    pub envelope: FormatEnvelope,
}

fn normalize_protocol_token(raw_protocol: &str, payload: &Value) -> String {
    let normalized = raw_protocol.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "openai-chat" | "chat" => "openai-chat".to_string(),
        "openai-responses" | "responses" => "openai-responses".to_string(),
        "anthropic-messages" | "anthropic" | "messages" => "anthropic-messages".to_string(),
        "gemini-chat" | "gemini" => "gemini-chat".to_string(),
        _ => {
            if payload.get("contents").is_some() {
                "gemini-chat".to_string()
            } else if payload.get("input").is_some() {
                "openai-responses".to_string()
            } else if payload.get("messages").is_some() {
                "openai-chat".to_string()
            } else {
                "openai-chat".to_string()
            }
        }
    }
}

pub fn parse_format_envelope(input: FormatParseInput) -> Result<FormatParseOutput, String> {
    if !input.raw_request.is_object() {
        return Err("Request payload must be an object".to_string());
    }
    let protocol = normalize_protocol_token(&input.protocol, &input.raw_request);
    let model = input
        .raw_request
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let metadata = if model.trim().is_empty() {
        None
    } else {
        Some(serde_json::json!({
            "model": model,
            "extracted_at": "format_parse"
        }))
    };
    let envelope = FormatEnvelope {
        format: protocol,
        version: "v1".to_string(),
        payload: input.raw_request,
        metadata,
    };

    Ok(FormatParseOutput { envelope })
}

pub(crate) fn parse_format_envelope_json(input_json: String) -> napi::Result<String> {
    // Validate input JSON is not empty
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: FormatParseInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = parse_format_envelope(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_openai_responses_request() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "gpt-4",
                "messages": [{"role": "user", "content": "hello"}]
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert_eq!(result.envelope.version, "v1");
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "gpt-4");
    }

    #[test]
    fn test_parse_anthropic_messages_request() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "claude-3-opus",
                "max_tokens": 1024
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "anthropic-messages");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "claude-3-opus"
        );
    }

    #[test]
    fn test_parse_gemini_chat_request() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "gemini-pro",
                "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "gemini-chat");
    }

    // Permissive path: Missing 'model' field is accepted
    #[test]
    fn test_accepts_missing_model_field() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "messages": [{"role": "user", "content": "hello"}]
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert!(result.envelope.metadata.is_none());
    }

    // Permissive path: Invalid model field type (not string) is accepted
    #[test]
    fn test_accepts_invalid_model_type() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": 123,
                "messages": []
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert!(result.envelope.metadata.is_none());
    }

    // Permissive path: Empty model string is accepted
    #[test]
    fn test_accepts_empty_model() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "",
                "messages": []
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert!(result.envelope.metadata.is_none());
    }

    // Permissive path: Missing 'max_tokens' for anthropic is accepted
    #[test]
    fn test_accepts_missing_max_tokens_anthropic() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "claude-3-opus"
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "anthropic-messages");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "claude-3-opus"
        );
    }

    // Permissive path: Invalid max_tokens type is accepted
    #[test]
    fn test_accepts_invalid_max_tokens_type() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "claude-3-opus",
                "max_tokens": "not_a_number"
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "anthropic-messages");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "claude-3-opus"
        );
    }

    // Failure path 6: Empty JSON input
    #[test]
    fn test_error_empty_json_input() {
        let result = parse_format_envelope_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    // Failure path 7: Invalid JSON input
    #[test]
    fn test_error_invalid_json_input() {
        let result = parse_format_envelope_json("not valid json".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to parse input JSON"));
    }

    // Permissive path: Invalid messages field type is accepted
    #[test]
    fn test_accepts_invalid_messages_type() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "gpt-4",
                "messages": "not_an_array"
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "gpt-4");
    }

    // Large payload test
    #[test]
    fn test_large_payload() {
        // Create a large payload with many messages
        let mut messages = Vec::new();
        for i in 0..1000 {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("Message {} with some content to increase size", i)
            }));
        }

        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": "gpt-4",
                "messages": messages
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
    }

    // NEW: Critical path test - OpenAI model field type object is accepted
    #[test]
    fn test_accepts_openai_model_type_object() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": {"name": "gpt-4"},
                "messages": []
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert!(result.envelope.metadata.is_none());
    }

    // NEW: Critical path test - Anthropic model field type array is accepted
    #[test]
    fn test_accepts_anthropic_model_type_array() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": ["claude-3-opus"],
                "max_tokens": 1024
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "anthropic-messages");
        assert!(result.envelope.metadata.is_none());
    }

    // NEW: Critical path test - Gemini model field type number is accepted
    #[test]
    fn test_accepts_gemini_model_type_number() {
        let input = FormatParseInput {
            raw_request: serde_json::json!({
                "model": 42,
                "contents": []
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = parse_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "gemini-chat");
        assert!(result.envelope.metadata.is_none());
    }
}
