use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub_pipeline_blocks::protocol::resolve_provider_protocol;
use crate::hub_pipeline_lib::effect_plan::{
    HubPipelineEffect, HubPipelineEffectKind, HubPipelineEffectPlan,
};

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseStreamEffectPlanOutput {
    pub effect_plan: HubPipelineEffectPlan,
    pub payload: Value,
    pub client_protocol: String,
}

pub(crate) fn resolve_sse_stream_mode(
    wants_stream: bool,
    client_protocol: &str,
) -> Result<bool, String> {
    match client_protocol.trim() {
        "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-chat" => {
            Ok(wants_stream)
        }
        "" => Err("Rust HubPipeline SSE stream requires client protocol".to_string()),
        _ => Ok(false),
    }
}

fn normalize_sse_stream_protocol(value: &str) -> Result<Option<String>, String> {
    if value.trim().is_empty() {
        return Err("Rust HubPipeline SSE stream requires client protocol".to_string());
    }
    let normalized = value.trim().to_lowercase();
    Ok(match normalized.as_str() {
        "openai-chat" | "openai" | "chat" => Some("openai-chat".to_string()),
        "responses" | "openai-responses" => Some("openai-responses".to_string()),
        "anthropic-messages" | "anthropic" | "messages" => {
            Some("anthropic-messages".to_string())
        }
        "gemini-chat" | "gemini" | "google-gemini" => Some("gemini-chat".to_string()),
        _ => None,
    })
}

pub fn process_sse_stream(input: SseStreamInput) -> Result<SseStreamOutput, String> {
    let Some(client_protocol) = normalize_sse_stream_protocol(&input.client_protocol)? else {
        return Ok(SseStreamOutput {
            should_stream: false,
            payload: input.client_payload,
        });
    };
    let should_stream = resolve_sse_stream_mode(input.wants_stream, &client_protocol)?;

    Ok(SseStreamOutput {
        should_stream,
        payload: input.client_payload,
    })
}

pub fn plan_sse_stream_effect(input: SseStreamInput) -> Result<SseStreamEffectPlanOutput, String> {
    let request_id = input.request_id.clone();
    let client_protocol = resolve_provider_protocol(&input.client_protocol)?;
    let output = process_sse_stream(input)?;
    let effect_plan = if output.should_stream {
        HubPipelineEffectPlan::single(HubPipelineEffect {
            kind: HubPipelineEffectKind::StreamPipe,
            payload: serde_json::json!({
                "codec": client_protocol,
                "requestId": request_id,
                "payload": output.payload.clone(),
                "body": output.payload.clone(),
            }),
        })
    } else {
        HubPipelineEffectPlan::empty()
    };
    Ok(SseStreamEffectPlanOutput {
        effect_plan,
        payload: output.payload,
        client_protocol,
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

#[napi]
pub fn plan_sse_stream_effect_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: SseStreamInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = plan_sse_stream_effect(input).map_err(napi::Error::from_reason)?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_sse_stream_mode_openai_chat() {
        assert!(resolve_sse_stream_mode(true, "openai-chat").unwrap());
        assert!(!resolve_sse_stream_mode(false, "openai-chat").unwrap());
    }

    #[test]
    fn test_resolve_sse_stream_mode_openai_responses() {
        assert!(resolve_sse_stream_mode(true, "openai-responses").unwrap());
        assert!(!resolve_sse_stream_mode(false, "openai-responses").unwrap());
    }

    #[test]
    fn test_resolve_sse_stream_mode_anthropic_messages() {
        assert!(resolve_sse_stream_mode(true, "anthropic-messages").unwrap());
        assert!(!resolve_sse_stream_mode(false, "anthropic-messages").unwrap());
    }

    #[test]
    fn test_resolve_sse_stream_mode_gemini_chat() {
        assert!(resolve_sse_stream_mode(true, "gemini-chat").unwrap());
        assert!(!resolve_sse_stream_mode(false, "gemini-chat").unwrap());
    }

    #[test]
    fn test_resolve_sse_stream_mode_trims_protocol_whitespace() {
        assert!(resolve_sse_stream_mode(true, " gemini-chat ").unwrap());
        assert!(resolve_sse_stream_mode(true, " openai-chat ").unwrap());
        assert!(!resolve_sse_stream_mode(false, " anthropic-messages ").unwrap());
    }

    #[test]
    fn test_resolve_sse_stream_mode_unknown_protocol() {
        assert!(!resolve_sse_stream_mode(true, "unknown-protocol").unwrap());
        assert!(!resolve_sse_stream_mode(false, "unknown-protocol").unwrap());
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
        assert!(!result.should_stream);
        assert_eq!(result.payload["result"], "data");
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
        assert_eq!(
            parsed.get("shouldStream").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            parsed
                .get("payload")
                .and_then(|v| v.get("ok"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn test_process_sse_stream_json_outputs_camel_case_fields() {
        let input_json = serde_json::json!({
            "clientPayload": { "result": "ok" },
            "clientProtocol": "openai-chat",
            "requestId": "req_output_case",
            "wantsStream": false
        })
        .to_string();

        let result = process_sse_stream_json(input_json).expect("json output");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("valid json");
        assert!(parsed.get("shouldStream").is_some());
        assert!(parsed.get("should_stream").is_none());
        assert_eq!(
            parsed.get("shouldStream").and_then(|v| v.as_bool()),
            Some(false)
        );
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
