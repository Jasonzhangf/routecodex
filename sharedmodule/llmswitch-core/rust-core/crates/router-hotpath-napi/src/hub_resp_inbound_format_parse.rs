use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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

fn parse_openai_chat_response(payload: &Value) -> Result<FormatEnvelope, String> {
    let materialized = materialize_openai_chat_response_payload(payload)?;
    validate_payload_size(&materialized)?;

    if !materialized.is_object() {
        return Err("OpenAI chat response must be a JSON object".to_string());
    }
    let choices = materialized
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI chat response must contain choices array".to_string())?;
    if choices.is_empty() {
        return Err("OpenAI chat response choices array must not be empty".to_string());
    }

    let model = materialized
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "openai-chat".to_string(),
        version: "v1".to_string(),
        payload: materialized,
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "resp_format_parse"
        })),
    })
}

#[derive(Default)]
struct OpenAiChatStreamChoice {
    role: Option<String>,
    content: String,
    reasoning_content: String,
    tool_calls: std::collections::BTreeMap<usize, OpenAiChatStreamToolCall>,
    finish_reason: Option<Value>,
}

#[derive(Default)]
struct OpenAiChatStreamToolCall {
    id: Option<String>,
    kind: Option<String>,
    function_name: Option<String>,
    function_arguments: String,
}

fn materialize_openai_chat_response_payload(payload: &Value) -> Result<Value, String> {
    if payload.get("choices").and_then(Value::as_array).is_some() {
        return Ok(payload.clone());
    }
    if let Some(body_text) = payload
        .get("bodyText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return materialize_openai_chat_sse_body_text(body_text);
    }
    if let Some(body) = payload.get("body") {
        if body.get("choices").and_then(Value::as_array).is_some() {
            return Ok(body.clone());
        }
        if let Some(body_text) = body
            .get("bodyText")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            return materialize_openai_chat_sse_body_text(body_text);
        }
    }
    Ok(payload.clone())
}

fn parse_openai_chat_sse_json_events(body_text: &str) -> Vec<Value> {
    let mut events: Vec<Value> = Vec::new();
    let mut data_lines: Vec<String> = Vec::new();
    let flush = |events: &mut Vec<Value>, data_lines: &mut Vec<String>| {
        if data_lines.is_empty() {
            return;
        }
        let data = data_lines.join("\n");
        data_lines.clear();
        let trimmed = data.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            events.push(value);
        }
    };

    for line in body_text.lines() {
        let trimmed_end = line.trim_end_matches('\r');
        if trimmed_end.is_empty() {
            flush(&mut events, &mut data_lines);
            continue;
        }
        if let Some(raw) = trimmed_end.strip_prefix("data:") {
            data_lines.push(raw.trim_start().to_string());
        }
    }
    flush(&mut events, &mut data_lines);
    events
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn materialize_openai_chat_sse_body_text(body_text: &str) -> Result<Value, String> {
    let events = parse_openai_chat_sse_json_events(body_text);
    if events.is_empty() {
        return Err("OpenAI chat SSE response did not contain JSON data events".to_string());
    }

    let mut response_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut created: Option<Value> = None;
    let mut usage: Option<Value> = None;
    let mut choices = std::collections::BTreeMap::<usize, OpenAiChatStreamChoice>::new();

    for event in events {
        let Some(event_row) = event.as_object() else {
            continue;
        };
        response_id = read_trimmed_string(event_row.get("id")).or(response_id);
        model = read_trimmed_string(event_row.get("model")).or(model);
        if created.is_none() {
            created = event_row.get("created").cloned();
        }
        if event_row.get("usage").is_some() && !event_row.get("usage").unwrap_or(&Value::Null).is_null() {
            usage = event_row.get("usage").cloned();
        }
        let Some(event_choices) = event_row.get("choices").and_then(Value::as_array) else {
            continue;
        };
        for choice_value in event_choices {
            let Some(choice_row) = choice_value.as_object() else {
                continue;
            };
            let index = choice_row.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let choice = choices.entry(index).or_default();
            if choice_row.get("finish_reason").is_some() && !choice_row.get("finish_reason").unwrap_or(&Value::Null).is_null() {
                choice.finish_reason = choice_row.get("finish_reason").cloned();
            }
            let Some(delta) = choice_row.get("delta").and_then(Value::as_object) else {
                continue;
            };
            choice.role = read_trimmed_string(delta.get("role")).or(choice.role.take());
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                choice.content.push_str(content);
            }
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
            {
                choice.reasoning_content.push_str(reasoning);
            }
            if let Some(tool_call_deltas) = delta.get("tool_calls").and_then(Value::as_array) {
                for tool_call_value in tool_call_deltas {
                    let Some(tool_call_row) = tool_call_value.as_object() else {
                        continue;
                    };
                    let tool_index = tool_call_row.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let tool_call = choice.tool_calls.entry(tool_index).or_default();
                    tool_call.id = read_trimmed_string(tool_call_row.get("id")).or(tool_call.id.take());
                    tool_call.kind = read_trimmed_string(tool_call_row.get("type")).or(tool_call.kind.take());
                    if let Some(function) = tool_call_row.get("function").and_then(Value::as_object) {
                        tool_call.function_name = read_trimmed_string(function.get("name")).or(tool_call.function_name.take());
                        if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                            tool_call.function_arguments.push_str(arguments);
                        }
                    }
                }
            }
        }
    }

    if choices.is_empty() {
        return Err("OpenAI chat SSE response did not contain choices array".to_string());
    }

    let mut materialized_choices: Vec<Value> = Vec::new();
    for (index, choice) in choices {
        let mut message = Map::new();
        message.insert(
            "role".to_string(),
            Value::String(choice.role.unwrap_or_else(|| "assistant".to_string())),
        );
        message.insert("content".to_string(), Value::String(choice.content));
        if !choice.reasoning_content.is_empty() {
            message.insert(
                "reasoning_content".to_string(),
                Value::String(choice.reasoning_content),
            );
        }
        if !choice.tool_calls.is_empty() {
            let tool_calls = choice
                .tool_calls
                .into_iter()
                .map(|(tool_index, tool_call)| {
                    Value::Object(Map::from_iter([
                        (
                            "id".to_string(),
                            Value::String(tool_call.id.unwrap_or_else(|| format!("call_{tool_index}"))),
                        ),
                        (
                            "type".to_string(),
                            Value::String(tool_call.kind.unwrap_or_else(|| "function".to_string())),
                        ),
                        (
                            "function".to_string(),
                            Value::Object(Map::from_iter([
                                (
                                    "name".to_string(),
                                    Value::String(tool_call.function_name.unwrap_or_else(|| "tool".to_string())),
                                ),
                                (
                                    "arguments".to_string(),
                                    Value::String(tool_call.function_arguments),
                                ),
                            ])),
                        ),
                    ]))
                })
                .collect::<Vec<Value>>();
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
        materialized_choices.push(Value::Object(Map::from_iter([
            ("index".to_string(), Value::from(index as u64)),
            ("message".to_string(), Value::Object(message)),
            (
                "finish_reason".to_string(),
                choice.finish_reason.unwrap_or(Value::String("stop".to_string())),
            ),
        ])));
    }

    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        Value::String(response_id.unwrap_or_else(|| "chatcmpl_sse".to_string())),
    );
    response.insert("object".to_string(), Value::String("chat.completion".to_string()));
    response.insert("model".to_string(), Value::String(model.unwrap_or_default()));
    response.insert("choices".to_string(), Value::Array(materialized_choices));
    if let Some(created) = created {
        response.insert("created".to_string(), created);
    }
    if let Some(usage) = usage {
        response.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(response))
}

fn unsupported_protocol_error(protocol: &str) -> String {
    format!(
        "Unsupported response protocol for Rust HubPipeline resp format parse: {}",
        protocol
    )
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
        "openai-chat" => parse_openai_chat_response(&input.payload)?,
        "openai-responses" => parse_openai_responses_response(&input.payload)?,
        "anthropic-messages" => parse_anthropic_messages_response(&input.payload)?,
        "gemini-chat" => parse_gemini_chat_response(&input.payload)?,
        _ => return Err(unsupported_protocol_error(&input.protocol)),
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
    fn test_parse_openai_chat_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "chatcmpl_123",
                "model": "gpt-4",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "hello"},
                    "finish_reason": "stop"
                }]
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(result.envelope.version, "v1");
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "gpt-4");
    }

    #[test]
    fn test_openai_chat_missing_choices_fails_fast() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "raw_unobservable_shape"
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("OpenAI chat response must contain choices array"));
    }

    #[test]
    fn test_parse_openai_chat_sse_body_text_wrapper() {
        let body_text = concat!(
            "data: {\"id\":\"chatcmpl_sse_1\",\"object\":\"chat.completion.chunk\",\"model\":\"MiniMax-M2.7\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"id\":\"chatcmpl_sse_1\",\"object\":\"chat.completion.chunk\",\"model\":\"MiniMax-M2.7\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n",
            "data: {\"id\":\"chatcmpl_sse_1\",\"object\":\"chat.completion.chunk\",\"model\":\"MiniMax-M2.7\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "MiniMax-M2.7");
        assert_eq!(result.envelope.payload["choices"][0]["message"]["role"], "assistant");
        assert_eq!(result.envelope.payload["choices"][0]["message"]["content"], "ok");
        assert_eq!(result.envelope.payload["choices"][0]["message"]["reasoning_content"], "think");
        assert_eq!(result.envelope.payload["choices"][0]["finish_reason"], "tool_calls");
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
    fn test_unknown_protocol_fails_fast() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "custom_field": "value"
            }),
            protocol: "custom-protocol".to_string(),
        };

        let result = parse_resp_format_envelope(input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported response protocol"));
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
