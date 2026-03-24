use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseStreamInput {
    pub client_payload: Value,
    pub client_protocol: String,
    pub request_id: String,
    pub wants_stream: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseStreamOutput {
    pub should_stream: bool,
    pub payload: Value,
}

fn resolve_sse_stream_mode(
    wants_stream: bool,
    client_protocol: &str,
    _original_wants_stream: bool,
) -> bool {
    // SSE streaming is only supported for specific protocols
    match client_protocol {
        "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-chat" => wants_stream,
        _ => false,
    }
}

pub fn process_sse_stream(input: SseStreamInput) -> Result<SseStreamOutput, String> {
    let should_stream = resolve_sse_stream_mode(
        input.wants_stream,
        &input.client_protocol,
        input.wants_stream,
    );

    Ok(SseStreamOutput {
        should_stream,
        payload: input.client_payload,
    })
}

#[napi]
pub fn process_sse_stream_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: SseStreamInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = process_sse_stream(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_sse_stream_mode_openai_chat() {
        assert!(resolve_sse_stream_mode(true, "openai-chat", true));
        assert!(!resolve_sse_stream_mode(false, "openai-chat", false));
    }

    #[test]
    fn test_resolve_sse_stream_mode_openai_responses() {
        assert!(resolve_sse_stream_mode(true, "openai-responses", true));
        assert!(!resolve_sse_stream_mode(false, "openai-responses", false));
    }

    #[test]
    fn test_resolve_sse_stream_mode_anthropic_messages() {
        assert!(resolve_sse_stream_mode(true, "anthropic-messages", true));
        assert!(!resolve_sse_stream_mode(false, "anthropic-messages", false));
    }

    #[test]
    fn test_resolve_sse_stream_mode_gemini_chat() {
        assert!(resolve_sse_stream_mode(true, "gemini-chat", true));
        assert!(!resolve_sse_stream_mode(false, "gemini-chat", false));
    }

    #[test]
    fn test_resolve_sse_stream_mode_unknown_protocol() {
        // Unknown protocols should not stream
        assert!(!resolve_sse_stream_mode(true, "unknown-protocol", true));
        assert!(!resolve_sse_stream_mode(false, "unknown-protocol", false));
    }

    #[test]
    fn test_process_sse_stream_enabled() {
        let input = SseStreamInput {
            client_payload: serde_json::json!({"choices": [{"text": "hello"}]}),
            client_protocol: "openai-chat".to_string(),
            request_id: "req_123".to_string(),
            wants_stream: true,
        };

        let result = process_sse_stream(input).unwrap();
        assert!(result.should_stream);
        assert_eq!(result.payload["choices"][0]["text"], "hello");
    }

    #[test]
    fn test_process_sse_stream_disabled() {
        let input = SseStreamInput {
            client_payload: serde_json::json!({"choices": [{"text": "hello"}]}),
            client_protocol: "openai-chat".to_string(),
            request_id: "req_123".to_string(),
            wants_stream: false,
        };

        let result = process_sse_stream(input).unwrap();
        assert!(!result.should_stream);
    }

    #[test]
    fn test_process_sse_stream_unknown_protocol() {
        let input = SseStreamInput {
            client_payload: serde_json::json!({"result": "data"}),
            client_protocol: "custom-protocol".to_string(),
            request_id: "req_123".to_string(),
            wants_stream: true,
        };

        let result = process_sse_stream(input).unwrap();
        assert!(!result.should_stream); // Unknown protocol should not stream
    }

    #[test]
    fn test_error_empty_json_input() {
        let result = process_sse_stream_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    #[test]
    fn test_error_invalid_json_input() {
        let result = process_sse_stream_json("not valid json".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_process_sse_stream_json_accepts_camel_case_input() {
        let input_json = serde_json::json!({
            "clientPayload": { "ok": true },
            "clientProtocol": "openai-chat",
            "requestId": "req_camel_case",
            "wantsStream": true
        })
        .to_string();

        let result = process_sse_stream_json(input_json).expect("json output");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("valid json");
        assert_eq!(parsed.get("shouldStream").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(parsed.get("payload").and_then(|v| v.get("ok")).and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn test_process_sse_stream_json_outputs_camel_case_fields() {
        let input_json = serde_json::json!({
            "clientPayload": { "result": "ok" },
            "clientProtocol": "unknown-protocol",
            "requestId": "req_output_case",
            "wantsStream": true
        })
        .to_string();

        let result = process_sse_stream_json(input_json).expect("json output");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("valid json");
        assert!(parsed.get("shouldStream").is_some());
        assert!(parsed.get("should_stream").is_none());
        assert_eq!(parsed.get("shouldStream").and_then(|v| v.as_bool()), Some(false));
    }

    // Critical path test: Empty request_id (should still work)
    #[test]
    fn test_empty_request_id() {
        let input = SseStreamInput {
            client_payload: serde_json::json!({"test": "data"}),
            client_protocol: "openai-chat".to_string(),
            request_id: "".to_string(),
            wants_stream: true,
        };

        let result = process_sse_stream(input).unwrap();
        assert!(result.should_stream);
    }

    // Critical path test: Large payload passthrough
    #[test]
    fn test_large_payload_passthrough() {
        let mut choices = Vec::new();
        for i in 0..100 {
            choices.push(serde_json::json!({
                "index": i,
                "delta": {"content": format!("chunk {}", i)}
            }));
        }

        let input = SseStreamInput {
            client_payload: serde_json::json!({
                "id": "resp_large",
                "choices": choices
            }),
            client_protocol: "openai-chat".to_string(),
            request_id: "req_large".to_string(),
            wants_stream: true,
        };

        let result = process_sse_stream(input).unwrap();
        assert!(result.should_stream);
        assert!(
            result
                .payload
                .get("choices")
                .unwrap()
                .as_array()
                .unwrap()
                .len()
                == 100
        );
    }
}
