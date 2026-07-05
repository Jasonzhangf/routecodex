// feature_id: sse.runtime_rust_dispatch
// Runtime SSE protocol dispatch lives in Rust. TS runtime callers may pass an
// explicit protocol, but must not reimplement protocol-specific dispatch.
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::anthropic_sse_event_payload;
use crate::chat_sse_event_payload;
use crate::gemini_sse_event_payload;
use crate::hub_resp_inbound_format_parse;
use crate::responses_sse_event_payload;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SseRuntimeInput {
    protocol: String,
    #[serde(default)]
    response: Option<Value>,
    #[serde(default, alias = "body_text")]
    body_text: Option<String>,
    #[serde(default)]
    body_text_camel: Option<String>,
    #[serde(default, alias = "request_id")]
    request_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    config: Option<Value>,
}

fn normalize_protocol(protocol: &str) -> Result<&'static str, String> {
    match protocol.trim() {
        "openai-chat" => Ok("openai-chat"),
        "openai-responses" => Ok("openai-responses"),
        "anthropic-messages" => Ok("anthropic-messages"),
        "gemini-chat" => Ok("gemini-chat"),
        other => Err(format!("Unsupported SSE protocol: {}", other)),
    }
}

fn read_input(input_json: String, operation: &str) -> Result<SseRuntimeInput, String> {
    let input: SseRuntimeInput = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse {} input JSON: {}", operation, error))?;
    normalize_protocol(&input.protocol)?;
    Ok(input)
}

fn encode_input_json(input: &SseRuntimeInput) -> Result<String, String> {
    let response = input
        .response
        .clone()
        .ok_or_else(|| "SSE JSON->SSE dispatch missing response".to_string())?;
    let mut payload = Map::new();
    payload.insert("response".to_string(), response);
    if let Some(model) = input.model.as_deref() {
        payload.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(request_id) = input.request_id.as_deref() {
        payload.insert(
            "request_id".to_string(),
            Value::String(request_id.to_string()),
        );
    }
    payload.insert(
        "config".to_string(),
        input
            .config
            .clone()
            .unwrap_or_else(|| Value::Object(Map::new())),
    );
    serde_json::to_string(&Value::Object(payload)).map_err(|error| {
        format!(
            "Failed to serialize SSE JSON->SSE dispatch input: {}",
            error
        )
    })
}

fn decode_input_json(input: &SseRuntimeInput) -> Result<String, String> {
    let body_text = input
        .body_text
        .as_deref()
        .or(input.body_text_camel.as_deref())
        .ok_or_else(|| "SSE SSE->JSON dispatch missing body_text".to_string())?;
    let mut payload = Map::new();
    match normalize_protocol(&input.protocol)? {
        "openai-responses" => {
            payload.insert("bodyText".to_string(), Value::String(body_text.to_string()));
        }
        _ => {
            payload.insert(
                "body_text".to_string(),
                Value::String(body_text.to_string()),
            );
        }
    }
    if let Some(model) = input.model.as_deref() {
        payload.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(request_id) = input.request_id.as_deref() {
        payload.insert(
            "request_id".to_string(),
            Value::String(request_id.to_string()),
        );
    }
    payload.insert(
        "config".to_string(),
        input
            .config
            .clone()
            .unwrap_or_else(|| Value::Object(Map::new())),
    );
    serde_json::to_string(&Value::Object(payload)).map_err(|error| {
        format!(
            "Failed to serialize SSE SSE->JSON dispatch input: {}",
            error
        )
    })
}

pub fn build_sse_frames_from_json_json(input_json: String) -> Result<String, String> {
    let input = read_input(input_json, "SSE JSON->SSE dispatch")?;
    let protocol = normalize_protocol(&input.protocol)?;
    let payload_json = encode_input_json(&input)?;
    match protocol {
        "openai-chat" => chat_sse_event_payload::build_chat_sse_stream_frames_json(payload_json),
        "openai-responses" => {
            responses_sse_event_payload::build_responses_sse_stream_frames_json(payload_json)
        }
        "anthropic-messages" => {
            anthropic_sse_event_payload::build_anthropic_sse_stream_frames_json(payload_json)
        }
        "gemini-chat" => {
            gemini_sse_event_payload::build_gemini_sse_stream_frames_json(payload_json)
        }
        _ => unreachable!(),
    }
}

pub fn build_json_from_sse_json(input_json: String) -> Result<String, String> {
    let input = read_input(input_json, "SSE SSE->JSON dispatch")?;
    let protocol = normalize_protocol(&input.protocol)?;
    let payload_json = decode_input_json(&input)?;
    match protocol {
        "openai-chat" => chat_sse_event_payload::build_chat_json_from_sse_json(payload_json),
        "openai-responses" => {
            let envelope_json =
                hub_resp_inbound_format_parse::build_responses_json_from_sse_json(payload_json)?;
            let envelope: Value = serde_json::from_str(&envelope_json).map_err(|error| {
                format!("Failed to parse Responses SSE decode envelope: {}", error)
            })?;
            let payload = envelope
                .get("payload")
                .cloned()
                .ok_or_else(|| "Responses SSE decode envelope missing payload".to_string())?;
            serde_json::to_string(&payload).map_err(|error| {
                format!(
                    "Failed to serialize Responses SSE decode payload: {}",
                    error
                )
            })
        }
        "anthropic-messages" => {
            anthropic_sse_event_payload::build_anthropic_json_from_sse_json(payload_json)
        }
        "gemini-chat" => gemini_sse_event_payload::build_gemini_json_from_sse_json(payload_json),
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_json_from_sse_json, build_sse_frames_from_json_json};
    use serde_json::json;

    #[test]
    fn rejects_unknown_protocol_for_encode() {
        let err = build_sse_frames_from_json_json(
            json!({
                "protocol": "unknown-protocol",
                "response": {}
            })
            .to_string(),
        )
        .expect_err("unknown protocol must fail");
        assert!(err.contains("Unsupported SSE protocol: unknown-protocol"));
    }

    #[test]
    fn rejects_unknown_protocol_for_decode() {
        let err = build_json_from_sse_json(
            json!({
                "protocol": "unknown-protocol",
                "body_text": ""
            })
            .to_string(),
        )
        .expect_err("unknown protocol must fail");
        assert!(err.contains("Unsupported SSE protocol: unknown-protocol"));
    }

    #[test]
    fn accepts_snake_case_request_id_for_responses_encode_dispatch() {
        let output = build_sse_frames_from_json_json(
            json!({
                "protocol": "openai-responses",
                "request_id": "req_responses_snake_dispatch",
                "response": {
                    "id": "resp_snake_dispatch",
                    "object": "response",
                    "created_at": 1781149537,
                    "status": "completed",
                    "model": "gpt-test",
                    "output": []
                },
                "config": {
                    "enableTimestampGeneration": false,
                    "includeSequenceNumbers": true
                }
            })
            .to_string(),
        )
        .expect("snake_case request_id must reach Responses SSE encoder");

        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
        let first_frame = parsed["frames"][0].as_str().unwrap();
        assert!(
            first_frame.contains("event: response.created"),
            "Responses SSE encoder must accept snake_case request_id and emit frames"
        );
        let last_frame = parsed["frames"]
            .as_array()
            .and_then(|frames| frames.last())
            .and_then(|frame| frame.as_str())
            .unwrap();
        assert_eq!(last_frame, "data: [DONE]\n\n");
    }

    #[test]
    fn accepts_snake_case_body_text_for_responses_decode_dispatch() {
        let output = build_json_from_sse_json(
            json!({
                "protocol": "openai-responses",
                "body_text": "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_decode\",\"object\":\"response\",\"created_at\":1781149537,\"status\":\"completed\",\"model\":\"gpt-test\",\"output\":[]}}\n\n",
                "request_id": "req_responses_decode_snake"
            })
            .to_string(),
        )
        .expect("snake_case body_text must reach Responses SSE decoder");

        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed["id"], json!("resp_decode"));
    }
}
